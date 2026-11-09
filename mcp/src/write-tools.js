/* The write tools. log_workout files a session the user describes ("dumbbell curls, 12 kg,
   12/12/10, last set to failure") into their history, through their own openGym server
   (api-client.js), as if it had been logged on the phone: every device shows it within the
   half minute they poll the revision.

   The language is the LLM's job and the arithmetic is the lib's (frontend/src/lib/log-workout.js):
   the client turns what was said into exercises and sets, and this builds, checks and files them.
   What the lib will not guess at — a name the library spells twice, an exercise the user has not
   made yet — comes back as `problems` with candidates, for the LLM to put to the user.

   save_routine does the same for a routine ("Day A: leg press 3 × 12, plank 3 × 30 s"), built by
   frontend/src/lib/save-routine.js, and can put it on weekdays of the weekly plan. Both write
   through writeProfile below: the token's profile checked, then GET, change, PUT, retry on 409. */
import { z } from 'zod'
import { isoDate, entryView, withCustomsIndexed } from './tools.js'
import { localUid, invalidate } from './state.js'
import { apiConfig, apiFetch } from './api-client.js'
import { buildLoggedWorkout, appendLoggedWorkout, findDuplicate, BODY_PARTS, LOG_LIMITS } from '../../frontend/src/lib/log-workout.js'
import { friendlyDuration } from './labels.js'
import { buildRoutine, applyRoutine, routineView, ROUTINE_LIMITS } from '../../frontend/src/lib/save-routine.js'

const localIso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
const hhmm = t => { const d = new Date(t); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') }
// Two writers racing the same profile resolve in a round or two; past that something keeps
// writing, and the user is better told than retried at.
const MAX_ATTEMPTS = 3
// Saves per hour, per MCP process. Logging a week someone forgot is a handful; a client looping on
// the tool is not, and each save is a full profile write on the server that every device pulls.
export const WRITE_LIMIT = 20
const WINDOW_MS = 60 * 60000
let saves = []
export const _resetWriteWindow = () => { saves = [] }

function fail(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

// The tool's snake_case parameters as the lib's description.
const inputOf = p => ({
  date: p.date,
  start: p.start,
  durationMin: p.duration_min,
  name: p.name,
  note: p.note,
  unit: p.unit,
  exercises: (p.exercises || []).map(ex => ({
    exercise: ex.exercise,
    createCustom: ex.create_custom,
    bodyPart: ex.body_part,
    note: ex.note,
    sets: (ex.sets || []).map(s => ({ reps: s.reps, seconds: s.seconds, weight: s.weight, warmup: s.warmup, failure: s.failure, rir: s.rir, rpe: s.rpe })),
  })),
})

// What was (or would be) saved, read back the way get_workout reads a session, so the user can
// check it in the words the app uses ("12 × 12 kg", "1:00").
function viewOf(w, S, resolved) {
  const withCustoms = { ...S, customEx: [...(S.customEx || []), ...resolved.customEx] }
  return {
    workout_id: w.id,
    date: w.d,
    start: hhmm(w.start),
    duration: w.end > w.start ? friendlyDuration(w.end - w.start) : null,
    name: w.name,
    unit: S.unit === 'lb' ? 'lb' : 'kg',
    volume: w.vol,
    ...(w.note ? { note: w.note } : {}),
    prs: (w.prs || []).map(id => resolved.resolved.find(r => r.id === id)?.name || id),
    exercises: w.entries.map(e => {
      const v = entryView(e, withCustoms)
      const r = resolved.resolved.find(x => x.id === e.id)
      return {
        id: e.id,
        name: v.name,
        ...(r?.input !== undefined && r.input !== v.name ? { you_said: r.input } : {}),
        ...(r?.created ? { new_custom_exercise: true } : {}),
        ...(r?.weightMeans ? { weight_means: r.weightMeans === 'each' ? 'per dumbbell' : 'both dumbbells together' } : {}),
        // The numbers spelled out next to the app's own label ("12×10 F": 12 kg, 10 reps, to
        // failure), so reading it back to the user cannot swap the weight and the reps.
        sets: e.sets.map((row, i) => ({
          label: v.sets[i].label,
          weight: Number(row.w) || 0,
          ...(row.sec != null ? { seconds: row.sec } : { reps: row.r }),
          ...(row.phase === 'warmup' ? { warmup: true } : {}),
          ...(row.failure ? { failure: true } : {}),
          ...(row.rir != null ? { rir: row.rir } : {}),
          ...(row.rpe != null ? { rpe: row.rpe } : {}),
        })),
        ...(e.note ? { note: e.note } : {}),
      }
    }),
  }
}

// Saves per hour, per tool. One window per tool, so filling in a forgotten week of workouts does
// not stop a routine from being saved.
function checkRate(tool, now, dryRun, message) {
  saves = saves.filter(x => now - x.t < WINDOW_MS)
  if (!dryRun && saves.filter(x => x.tool === tool).length >= WRITE_LIMIT) throw fail('ERATE', message)
}

/**
 * One change to the profile, through the server, the way a paired device makes it: check whose
 * token this is, GET the document, let `apply` change a copy, PUT it with the revision it was read
 * at, and on a 409 run `apply` again on the document the server sent back.
 *
 * `apply(S)` changes S in place and returns { result } to answer without writing (a preview, a
 * problem), or { save: true, result: rev => answer, trail: rev => stderr line }.
 */
async function writeProfile({ env = process.env, fetchImpl, now, tool = 'log_workout' }, apply) {
  const cfg = apiConfig(env)
  const opts = fetchImpl ? { fetchImpl } : {}
  const me = await apiFetch(cfg, '/api/me', opts)
  const uid = me.body?.user?.id
  // A guard that cannot read whose token this is refuses rather than steps aside.
  if (typeof uid !== 'string' || !uid) throw fail('EAPI', 'the openGym server did not say which profile OPENGYM_TOKEN belongs to (GET /api/me); nothing was saved')
  const local = localUid()
  if (local && local !== uid) {
    // The ids go to the operator on stderr, not into the model's context (state.js ambiguousUid).
    console.error(`[opengym-mcp] OPENGYM_TOKEN is for profile ${uid}, this server reads ${local}`)
    throw fail('EPROFILE', 'OPENGYM_TOKEN belongs to another profile than the one this server reads: pair again from the right profile, or set OPENGYM_UID to match (the ids are on the server\'s stderr)')
  }

  let got = await apiFetch(cfg, '/api/data', opts)
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const doc = got.body?.state
    if (!doc || typeof doc !== 'object') {
      throw fail('ENOSTATE', 'this profile has no synced data on the server yet: open openGym and sign in on a device once, then try again')
    }
    // The document exactly as the server sent it, plus the change: anything else in the PUT — a
    // default filled in here — would be stamped as an edit made now and land on every device.
    const S = structuredClone(doc)
    const step = apply(S)
    if (!step.save) return step.result
    const put = await apiFetch(cfg, '/api/data', { ...opts, method: 'PUT', body: { state: S, baseRev: got.body.rev ?? 0, ...(typeof doc._wid === 'string' ? { baseWid: doc._wid } : {}) } })
    if (put.status !== 409) {
      invalidate()
      saves.push({ tool, t: now })
      console.error('[opengym-mcp] ' + step.trail(put.body?.rev))
      return step.result(put.body?.rev)
    }
    // Another device wrote in between: the server sent its current document back with the 409,
    // so the change is made again on top of that one. A 409 without one (a proxy's page) is not
    // something to build on.
    if (!put.body?.state || typeof put.body.state !== 'object' || typeof put.body.rev !== 'number') {
      throw fail('EAPI', 'the openGym server answered 409 without the current profile; nothing was saved')
    }
    got = { status: 200, body: { state: put.body.state, rev: put.body.rev } }
  }
  throw fail('ECONFLICT', `the profile kept changing on the server (${MAX_ATTEMPTS} attempts); nothing was saved, try again in a moment`)
}

const setSchema = z.object({
  reps: z.number().int().min(1).max(LOG_LIMITS.maxReps).optional().describe('Reps done. Give reps for a rep exercise, or seconds for a hold, never both in one exercise.'),
  seconds: z.number().min(1).max(LOG_LIMITS.maxSec).optional().describe('Seconds held, for a timed exercise (plank, hang, wall sit).'),
  weight: z.number().min(0).optional().describe('Load in `unit`. Omit or 0 for bodyweight. On an assistance machine it is the help (less is better). For dumbbells: as the profile logs that exercise (see weight_means in the reply).'),
  warmup: z.boolean().optional().describe('A warm-up set: kept out of volume, PRs and the next suggested weight.'),
  failure: z.boolean().optional().describe('Taken to failure.'),
  rir: z.number().min(0).max(10).optional().describe('Reps in reserve, if the user said it. Not with rpe.'),
  rpe: z.number().min(6).max(10).optional().describe('RPE, if the user said it. Not with rir.'),
})

export const logWorkout = {
  name: 'log_workout',
  description: [
    'Log a workout the user describes into their openGym history (it syncs to all their devices). Turn what they said into exercises and one entry per set:',
    '"curls, 12 kg, 12/12/10" is three sets of {reps, weight: 12}; "3 sets of 12, except the last was 10" is 12, 12, 10.',
    'Ask instead of assuming when the weight, the number of sets or the reps are unclear.',
    'Exercises are matched against the user\'s library by name or id. A common name resolves to the library\'s default variant ("shoulder press" is the barbell one): when the reply\'s `name` differs from `you_said` and the variant matters (dumbbell vs barbell, machine vs cable), confirm with the user, or pass an id. If a name matches several exercises, or none, nothing is saved and `problems` lists candidates: ask the user which one, then call again with its id.',
    'Only set create_custom for an exercise the user confirms is not in the library.',
    'Call with dry_run: true first when you had to interpret anything, show the user the preview, and log it once they agree.',
    'Calling again with the same description does not log it twice. Cardio (time and speed) and supersets are not supported here.',
  ].join(' '),
  schema: {
    date: isoDate().optional().describe('YYYY-MM-DD the session was done; defaults to today. Not in the future.'),
    start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM, 24 h').optional().describe('Start time HH:MM, if the user said it. Without it a session logged today ends now; one in the past starts at 18:00.'),
    duration_min: z.number().min(1).max(LOG_LIMITS.maxDurationMin).optional().describe('How long the session took, in minutes, if known.'),
    name: z.string().max(80).optional().describe('A name for the session, e.g. "Arms" or "Push day". Defaults to "Workout".'),
    note: z.string().max(500).optional().describe('A note on the whole session.'),
    unit: z.enum(['kg', 'lb']).optional().describe('The unit the user gave weights in; defaults to the profile\'s. Converted when it differs.'),
    exercises: z.array(z.object({
      exercise: z.string().min(1).max(120).describe('Exercise name as the user said it ("dumbbell curl"), or an exercise id from an earlier answer.'),
      create_custom: z.boolean().optional().describe('Create this as the user\'s own exercise when the library has nothing matching. Only after the user confirms.'),
      body_part: z.enum(BODY_PARTS).optional().describe('Body part of a new custom exercise, when its name does not say.'),
      note: z.string().max(280).optional().describe('A note on this exercise today.'),
      sets: z.array(setSchema).min(1).max(LOG_LIMITS.maxSets),
    })).min(1).max(LOG_LIMITS.maxExercises),
    dry_run: z.boolean().optional().describe('Build and return the preview without saving anything.'),
    allow_duplicate: z.boolean().optional().describe('Log it even though the same sets are already logged that day (a genuine second session). Give it a different start or name too.'),
  },
  handler: async (params, { env = process.env, fetchImpl } = {}) => {
    // One clock for every attempt: a retry after a conflict files the same workout, not a later one.
    const now = Date.now()
    checkRate('log_workout', now, params.dry_run, `log_workout already saved ${WRITE_LIMIT} workouts in the last hour, the most it takes in one go; nothing was saved. Wait a bit, or log the rest in the app.`)
    const input = inputOf({ ...params, date: params.date || localIso(new Date(now)) })
    // A description without a unit is in the profile's, as the profile was when first read: a
    // retry after another device switched kg ↔ lb reads the same numbers the same way.
    let unit = null, meanings = null
    return writeProfile({ env, fetchImpl, now }, S => {
      unit = unit || (S.unit === 'lb' ? 'lb' : 'kg')
      // The profile's own exercises indexed for the build, as the app has them: a custom one-arm
      // dumbbell press counts one bell, a custom assisted machine folds towards less help.
      const built = withCustomsIndexed(S, () => buildLoggedWorkout(S, input, { now, unit, meanings }))
      if (built.problems) {
        return { result: { logged: false, problems: built.problems, next: 'Nothing was saved. Settle these with the user (pick a candidate id, fix a set) and call again.' } }
      }
      // What each dumbbell weight meant on the first read stays what it means on a retry.
      meanings = meanings || Object.fromEntries(built.workout.entries.map(e => [e.id, e.target?.dbLoad || 'as']))
      const preview = viewOf(built.workout, S, built)
      if (params.dry_run) {
        const dup = findDuplicate(S, built.workout)
        return { result: { logged: false, dry_run: true, would_log: preview, ...(dup && (dup.sameRequest || !params.allow_duplicate) ? { duplicate_of: dup.workout.id } : {}) } }
      }
      const added = withCustomsIndexed({ customEx: [...(S.customEx || []), ...built.customEx] }, () =>
        appendLoggedWorkout(S, built, { now, allowDuplicate: params.allow_duplicate === true }))
      if (!added.added) {
        return { result: { logged: false, duplicate: true, workout_id: added.workout.id, date: added.workout.d, message: 'This session is already in the history; nothing was added. If it really was a second session, call again with allow_duplicate: true and a different start or name.' } }
      }
      const sets = added.workout.entries.reduce((n, e) => n + e.sets.length, 0)
      return {
        save: true,
        // The operator's trail (stderr, as the profile guard's): which workout went in, for what
        // day and at which revision. Never the token, and nothing the model sees.
        trail: rev => `log_workout saved ${added.workout.id} for ${added.workout.d} (${added.workout.entries.length} exercises, ${sets} sets), rev ${rev ?? '?'}`,
        result: rev => ({ logged: true, ...viewOf(added.workout, S, built), revision: rev ?? null }),
      }
    })
  },
}

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

export const saveRoutine = {
  name: 'save_routine',
  description: [
    'Save a routine (a named list of exercises with their sets, reps and rest) into the user\'s openGym plan, where it syncs to all their devices; optionally put it on weekdays of the weekly plan.',
    'One call per routine: a two-day plan is two calls. To change a routine already saved, pass its routine_id (from list_routines): its exercise list is replaced by the one given, so send the whole list, not only what changed.',
    'Per exercise give reps (and reps_min for a range like 8 to 12), or seconds for a hold (plank), or minutes and speed_kmh for cardio (treadmill, bike). Leave weight out when the user has not chosen one yet: the app asks for it the first time and remembers it.',
    'Exercises are matched against the user\'s library by name or id, the way log_workout matches them: when the reply\'s `name` differs from `you_said` and the variant matters, confirm with the user or pass an id. A name that matches several exercises, or none, saves nothing and `problems` lists candidates: ask the user which one, then call again with its id.',
    'Only set create_custom for an exercise the user confirms is not in the library.',
    'Call with dry_run: true first, show the user the preview, and save once they agree.',
  ].join(' '),
  schema: {
    name: z.string().min(1).max(ROUTINE_LIMITS.nameMax).optional().describe('The routine\'s name, e.g. "Day A" or "Push". Needed for a new routine; a replaced one keeps its name unless given.'),
    routine_id: z.string().min(1).max(64).optional().describe('Replace this routine (from list_routines) instead of creating a new one.'),
    emoji: z.string().max(8).optional().describe('An emoji shown next to the name.'),
    unit: z.enum(['kg', 'lb']).optional().describe('The unit weights are given in; defaults to the profile\'s.'),
    exercises: z.array(z.object({
      exercise: z.string().min(1).max(120).describe('Exercise name ("leg press"), or an exercise id from an earlier answer.'),
      create_custom: z.boolean().optional().describe('Create this as the user\'s own exercise when the library has nothing matching. Only after the user confirms.'),
      body_part: z.enum(BODY_PARTS).optional().describe('Body part of a new custom exercise, when its name does not say.'),
      sets: z.number().int().min(1).max(ROUTINE_LIMITS.maxSets).optional().describe('Number of sets; defaults to 3 (1 for cardio).'),
      reps: z.number().int().min(1).max(ROUTINE_LIMITS.maxReps).optional().describe('Reps per set (the top of a range). With per_side, reps for each side: "8 per side" is reps 8, per_side true.'),
      reps_min: z.number().int().min(1).optional().describe('Bottom of a rep range: 8 to 12 is reps_min 8, reps 12.'),
      seconds: z.number().min(1).max(ROUTINE_LIMITS.maxSec).optional().describe('Seconds per set, for a hold (plank, wall sit). Not with reps.'),
      minutes: z.number().positive().max(ROUTINE_LIMITS.maxMin).optional().describe('Minutes, for a cardio exercise.'),
      speed_kmh: z.number().positive().max(ROUTINE_LIMITS.maxSpeedKmh).optional().describe('Speed in km/h, for a cardio exercise (convert mph: × 1.609).'),
      incline: z.number().positive().max(40).optional().describe('Treadmill incline in percent.'),
      weight: z.number().min(0).optional().describe('Planned load in `unit`. Omit when not chosen yet; 0 for bodyweight.'),
      per_side: z.boolean().optional().describe('One arm or leg at a time, counted per side. One-arm and one-leg library exercises are per side unless set false.'),
      rest_sec: z.number().int().min(0).max(ROUTINE_LIMITS.maxRestSec).optional().describe('Rest after each set, in seconds. Omit to use the app\'s rest timer; 0 for no timer.'),
      note: z.string().max(500).optional().describe('A note on this exercise, shown during the workout (a cue, a machine setting).'),
      superset: z.string().min(1).max(40).optional().describe('Label shared by exercises done back to back as a superset, e.g. "Arms". They must be next to each other in the list.'),
    })).min(1).max(ROUTINE_LIMITS.maxExercises),
    weekdays: z.array(z.enum(DAYS)).max(7).optional().describe('Put the routine on these days of the weekly plan. Leave out to only save the routine.'),
    weekdays_exclusive: z.boolean().optional().describe('With weekdays: the routine replaces whatever those days held, instead of being added beside it.'),
    allow_same_name: z.boolean().optional().describe('Save a new routine even though one with the same name exists. Prefer routine_id to replace it.'),
    dry_run: z.boolean().optional().describe('Build and return the preview without saving anything.'),
  },
  handler: async (params, { env = process.env, fetchImpl } = {}) => {
    const now = Date.now()
    checkRate('save_routine', now, params.dry_run, `save_routine already saved ${WRITE_LIMIT} routines in the last hour; nothing was saved. Wait a bit, or edit the rest in the app.`)
    const input = {
      name: params.name,
      routineId: params.routine_id,
      emoji: params.emoji,
      unit: params.unit,
      allowSameName: params.allow_same_name,
      exercises: (params.exercises || []).map(x => ({
        exercise: x.exercise, createCustom: x.create_custom, bodyPart: x.body_part, sets: x.sets,
        reps: x.reps, repsMin: x.reps_min, seconds: x.seconds, minutes: x.minutes, speedKmh: x.speed_kmh,
        incline: x.incline, weight: x.weight, perSide: x.per_side, restSec: x.rest_sec, note: x.note, superset: x.superset,
      })),
    }
    const weekdays = (params.weekdays || []).map(d => DAYS.indexOf(d))
    // The unit as first read, and the new routine's id: a retry after a conflict files the same
    // routine, not a second one with another id.
    let unit = null, id = null
    return writeProfile({ env, fetchImpl, now, tool: 'save_routine' }, S => {
      unit = unit || (S.unit === 'lb' ? 'lb' : 'kg')
      const built = withCustomsIndexed(S, () => buildRoutine(S, input, { unit }))
      if (built.problems) {
        return { result: { saved: false, problems: built.problems, next: 'Nothing was saved. Settle these with the user (pick a candidate id, fix a number) and call again.' } }
      }
      if (!input.routineId) { id = id || built.routine.id; built.routine.id = id }
      const preview = routineView(S, built)
      const days = weekdays.map(d => DAYS[d])
      if (params.dry_run) return { result: { saved: false, dry_run: true, would_save: preview, ...(days.length ? { weekdays: days } : {}) } }
      const { replaced } = applyRoutine(S, built, { weekdays, exclusive: params.weekdays_exclusive === true, now })
      return {
        save: true,
        trail: rev => `save_routine ${replaced ? 'replaced' : 'added'} ${built.routine.id} (${built.routine.ex.length} exercises${days.length ? ', ' + days.join(' ') : ''}), rev ${rev ?? '?'}`,
        result: rev => ({ saved: true, replaced, ...preview, ...(days.length ? { weekdays: days } : {}), revision: rev ?? null }),
      }
    })
  },
}

export const WRITE_TOOLS = [logWorkout, saveRoutine]
