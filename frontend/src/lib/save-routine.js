// A routine described rather than built in the editor ("Day A: leg press 3 × 12, lat pulldown 3 × 12,
// plank 3 × 30 s, then 15 min on the treadmill at 6 km/h") turned into the routine the Plan screen
// would have saved. Written for the MCP server's save_routine tool, which hands it a structured
// description an LLM read out of what the user said, and kept here, pure and beside its test,
// because a routine decides what the user lifts next.
//
// Names resolve the way log_workout resolves them (log-workout.js resolveExercise): a common name
// goes to the catalogue's default variant and the reply says which, while a name the catalogue
// spells twice, or one that matches nothing, comes back as a problem with candidates. Each exercise
// starts from what picking it in the editor gives (history.js pickedExerciseConfig) and takes the
// numbers it was given on top, so anything not said is what the app would have filled in.
import { EXIDX, isCardio } from './exercises.js'
import { pickedExerciseConfig, exLine, NOTE_MAX } from './history.js'
import { importId, bpFromName } from './import-csv.js'
import { resolveExercise, BODY_PARTS } from './log-workout.js'
import { clampIncline } from './incline.js'
import { stampRoutines, stampCustomEx } from './sync-merge.js'
import { SG_NAME_MAX } from './superset-meta.js'
import { uid } from './format.js'
import { speedUnitOf } from './speed.js'

const LB_TO_KG = 0.45359237
export const ROUTINE_LIMITS = {
  nameMax: 60, maxExercises: 40, maxSets: 20, maxReps: 100, maxSec: 3600,
  maxMin: 300, maxSpeedKmh: 40, maxRestSec: 900, maxKg: 2000,
}
const nameKey = n => String(n || '').toLowerCase().replace(/\s+/g, ' ').trim()
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const whole = v => num(v) != null && Number.isInteger(v)

/**
 * The routine `input` describes, or the problems that stop it. Nothing in `S` is changed.
 *
 * input: { name, emoji?, routineId?, exercises: [{ exercise, createCustom?, bodyPart?, sets?,
 *   reps?, repsMin?, seconds?, minutes?, speedKmh?, incline?, weight?, perSide?, restSec?, note?,
 *   superset? }] }, weights in `unit` (the profile's when absent).
 *
 * Returns { routine, customEx, resolved } or { problems }. `routineId` names a routine of the
 * profile to replace: it keeps its id, its emoji and its progression settings unless given new
 * ones, and its exercise list becomes the one described.
 */
export function buildRoutine(S, input, { unit: givenUnit } = {}) {
  const problems = []
  const profileUnit = S.unit === 'lb' ? 'lb' : 'kg'
  const unit = input?.unit ?? givenUnit ?? profileUnit
  if (unit !== 'kg' && unit !== 'lb') problems.push({ field: 'unit', problem: "must be 'kg' or 'lb'" })
  // Converted only when the description is in the other unit, to the tenth the importer keeps.
  const toProfile = w => (unit === profileUnit ? w : Math.round((unit === 'lb' ? w * LB_TO_KG : w / LB_TO_KG) * 10) / 10)
  const toKg = w => (unit === 'lb' ? w * LB_TO_KG : w)

  const routines = Array.isArray(S.routines) ? S.routines : []
  let base = null
  if (input?.routineId != null) {
    base = routines.find(r => r && r.id === input.routineId) || null
    if (!base) problems.push({ field: 'routineId', problem: 'no routine with this id in the profile', routines: routines.map(r => ({ id: r.id, name: r.name })) })
  }
  const name = String(input?.name ?? base?.name ?? '').trim()
  if (!name) problems.push({ field: 'name', problem: 'a routine needs a name' })
  else if (name.length > ROUTINE_LIMITS.nameMax) problems.push({ field: 'name', problem: `at most ${ROUTINE_LIMITS.nameMax} characters` })
  else {
    // A second routine under a name the profile already has is almost always the same one sent
    // twice: say so instead of filing a copy. Replacing it means passing its id.
    const same = routines.find(r => r && r.id !== base?.id && nameKey(r.name) === nameKey(name))
    if (same && input?.allowSameName !== true) {
      problems.push({ field: 'name', problem: 'the profile already has a routine with this name: pass its routineId to replace it, or pick another name', existing: { id: same.id, name: same.name } })
    }
  }

  const exercises = Array.isArray(input?.exercises) ? input.exercises : []
  if (!exercises.length) problems.push({ field: 'exercises', problem: 'at least one exercise' })
  if (exercises.length > ROUTINE_LIMITS.maxExercises) problems.push({ field: 'exercises', problem: `at most ${ROUTINE_LIMITS.maxExercises}` })

  const customEx = []
  const resolved = []
  const ex = []
  const labels = []
  exercises.slice(0, ROUTINE_LIMITS.maxExercises).forEach((x, i) => {
    const at = `exercises[${i}]`
    const bad = (field, problem) => problems.push({ field: `${at}.${field}`, problem })
    let hit = resolveExercise({ ...S, customEx: [...(S.customEx || []), ...customEx] }, x?.exercise)
    if (hit.problem && x?.createCustom === true && String(x?.exercise ?? '').trim()) {
      const n = String(x.exercise).trim().slice(0, 80)
      const bp = x.bodyPart ?? bpFromName(n)
      if (!BODY_PARTS.includes(bp)) return bad('bodyPart', `needed for a new exercise: one of ${BODY_PARTS.join(', ')}`)
      // The same id log_workout gives the same name, so a routine and a logged session that both
      // create "Hack squat machine" end up with one exercise, not two.
      const c = { id: importId('mc', nameKey(n)), n, custom: true, eq: 'custom', tg: '', desc: '', bp }
      customEx.push(c)
      hit = { id: c.id, name: c.n, custom: true, created: true }
    }
    if (hit.problem) {
      problems.push({ field: `${at}.exercise`, exercise: x?.exercise ?? null, problem: hit.problem, ...(hit.candidates ? { candidates: hit.candidates } : {}) })
      return
    }
    const custom = [...(S.customEx || []), ...customEx].find(c => c.id === hit.id)
    const cardio = custom ? custom.bp === 'cardio' : isCardio(hit.id)
    const timed = x.seconds != null, counted = x.reps != null || x.repsMin != null, paced = x.minutes != null || x.speedKmh != null || x.incline != null
    if ([timed, counted, paced].filter(Boolean).length > 1) return bad('exercise', 'give reps, or seconds for a hold, or minutes and speed for cardio: one kind per exercise')
    if (cardio && (timed || counted)) return bad('exercise', 'a cardio exercise takes minutes and speed, not reps or seconds')
    if (!cardio && paced) return bad('exercise', 'minutes and speed are for a cardio exercise; this one is not')
    const mode = cardio ? 'cardio' : timed ? 'time' : 'reps'

    const cfg = { id: hit.id, ...pickedExerciseConfig(hit.id, mode) }
    if (x.sets != null) {
      if (!whole(x.sets) || x.sets < 1 || x.sets > ROUTINE_LIMITS.maxSets) return bad('sets', `a whole number, 1 to ${ROUTINE_LIMITS.maxSets}`)
      cfg.sets = x.sets
    }
    if (x.perSide != null) {
      if (mode === 'cardio') return bad('perSide', 'not for cardio')
      if (x.perSide) cfg.side = true; else delete cfg.side
    }
    if (mode === 'reps') {
      const reps = x.reps ?? (cfg.side ? cfg.reps / 2 : cfg.reps)
      if (!whole(reps) || reps < 1 || reps > ROUTINE_LIMITS.maxReps) return bad('reps', `a whole number, 1 to ${ROUTINE_LIMITS.maxReps}`)
      if (x.repsMin != null && (!whole(x.repsMin) || x.repsMin < 1 || x.repsMin >= reps)) return bad('repsMin', 'a whole number below reps (the bottom of a range like 8 to 12)')
      // Stored as the total of both sides (history.js isPerSide): "8 per side" is 16.
      const k = cfg.side ? 2 : 1
      cfg.reps = reps * k
      if (x.repsMin != null) cfg.repsMin = x.repsMin * k
    } else if (mode === 'time') {
      const sec = num(x.seconds)
      if (sec == null || sec < 1 || sec > ROUTINE_LIMITS.maxSec) return bad('seconds', `1 to ${ROUTINE_LIMITS.maxSec}`)
      cfg.sec = Math.round(sec)
    } else {
      if (x.minutes != null) {
        const min = num(x.minutes)
        if (min == null || min <= 0 || min > ROUTINE_LIMITS.maxMin) return bad('minutes', `more than 0, up to ${ROUTINE_LIMITS.maxMin}`)
        cfg.min = min
      }
      if (x.speedKmh != null) {
        const speed = num(x.speedKmh)
        if (speed == null || speed <= 0 || speed > ROUTINE_LIMITS.maxSpeedKmh) return bad('speedKmh', `more than 0, up to ${ROUTINE_LIMITS.maxSpeedKmh} km/h`)
        cfg.speed = speed
      }
      if (x.incline != null) {
        const inc = clampIncline(x.incline)
        if (!(inc > 0)) return bad('incline', 'a positive percentage')
        cfg.incline = inc
      }
    }
    if (x.weight != null) {
      if (mode === 'cardio') return bad('weight', 'not for cardio')
      const w = num(x.weight)
      if (w == null || w < 0 || toKg(w) > ROUTINE_LIMITS.maxKg) return bad('weight', 'zero or more, in ' + unit)
      cfg.weight = toProfile(w)
    }
    if (x.restSec != null) {
      const r = num(x.restSec)
      if (r == null || r < 0 || r > ROUTINE_LIMITS.maxRestSec) return bad('restSec', `0 to ${ROUTINE_LIMITS.maxRestSec} seconds`)
      // 0 is "no timer" for this exercise, as the editor stores it.
      if (r === 0) cfg.restOff = true; else cfg.restSec = Math.round(r)
    }
    if (x.note != null && String(x.note).trim()) cfg.note = String(x.note).trim().slice(0, NOTE_MAX)
    labels.push({ index: ex.length, at, label: x.superset == null ? '' : String(x.superset).trim() })
    resolved.push({ id: hit.id, input: x.exercise, name: hit.name, ...(hit.created ? { created: true } : {}) })
    ex.push(cfg)
  })

  // A superset is a run of neighbours sharing a label; the label is its name in the app. One that
  // is split by another exercise, or has a single member, is a mistake to put to the user.
  const groups = new Map()
  labels.forEach(l => { if (l.label) groups.set(l.label, [...(groups.get(l.label) || []), l]) })
  for (const [label, members] of groups) {
    const idx = members.map(m => m.index)
    if (members.length < 2) problems.push({ field: `${members[0].at}.superset`, problem: 'a superset needs at least two exercises with the same label' })
    else if (idx[idx.length - 1] - idx[0] !== idx.length - 1) problems.push({ field: `${members[0].at}.superset`, problem: 'the exercises of a superset must be next to each other' })
    else {
      const sg = uid()
      idx.forEach(i => { ex[i].sg = sg; ex[i].sgName = label.slice(0, SG_NAME_MAX) })
    }
  }

  if (problems.length) return { problems }
  const routine = {
    ...(base ? structuredClone(base) : {}),
    id: base ? base.id : uid(),
    name,
    ex,
  }
  if (input?.emoji != null) routine.emoji = String(input.emoji).slice(0, 8)
  // Stamps are the store's to set (stampRoutines below), never carried over from the old copy.
  delete routine._ts; delete routine._f; delete routine._u
  return { routine, customEx, resolved }
}

/**
 * Puts a built routine into the profile `S`, in place: a new one at the end of the list, a
 * replacement where the old one was. `weekdays` (getDay numbers, 0 is Sunday) puts it on those
 * days of the weekly plan, beside whatever else the day holds, or alone when `exclusive`; a
 * replaced routine given weekdays leaves every other day. The new custom exercises go in too, and
 * what changed is stamped the way the app's store stamps an edit.
 */
export function applyRoutine(S, built, { weekdays, exclusive = false, now = Date.now() } = {}) {
  const prevRoutines = Array.isArray(S.routines) ? S.routines.slice() : []
  const prevCustoms = Array.isArray(S.customEx) ? S.customEx.slice() : []
  const r = built.routine
  const at = prevRoutines.findIndex(x => x && x.id === r.id)
  const replaced = at >= 0
  S.routines = prevRoutines.slice()
  if (replaced) S.routines[at] = r; else S.routines.push(r)
  const mine = new Set(prevCustoms.map(c => c.id))
  S.customEx = [...prevCustoms, ...built.customEx.filter(c => !mine.has(c.id))]
  stampRoutines(prevRoutines, S.routines, now)
  if (S.customEx.length !== prevCustoms.length) stampCustomEx(prevCustoms, S.customEx, now)

  if (Array.isArray(weekdays) && weekdays.length) {
    const days = new Set(weekdays.map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))
    const week = { ...(S.week || {}) }
    for (let d = 0; d <= 6; d++) {
      const ids = week[d] == null ? [] : [].concat(week[d])
      let next = ids
      if (days.has(d)) next = exclusive ? [r.id] : ids.includes(r.id) ? ids : [...ids, r.id]
      else if (replaced) next = ids.filter(id => id !== r.id)
      // An emptied day is left absent, never stored as [] (routines.js deleteRoutine).
      if (next !== ids) { if (next.length) week[d] = next; else delete week[d] }
    }
    S.week = week
  }
  return { replaced, routine: r }
}

/** The routine read back in the editor's words, so the user can check what was understood. */
export function routineView(S, built) {
  const unit = S.unit === 'lb' ? 'lb' : 'kg'
  const customs = [...(S.customEx || []), ...built.customEx]
  return {
    routine_id: built.routine.id,
    name: built.routine.name,
    ...(built.routine.emoji ? { emoji: built.routine.emoji } : {}),
    unit,
    exercises: built.routine.ex.map((cfg, i) => {
      const r = built.resolved[i]
      const n = customs.find(c => c.id === cfg.id)?.n || EXIDX[cfg.id]?.n || cfg.id
      return {
        id: cfg.id,
        name: n,
        ...(r?.input !== undefined && nameKey(r.input) !== nameKey(n) ? { you_said: r.input } : {}),
        ...(r?.created ? { new_custom_exercise: true } : {}),
        summary: exLine(cfg, unit, speedUnitOf(S)),
        ...(cfg.side ? { per_side: true } : {}),
        ...(cfg.restSec ? { rest_sec: cfg.restSec } : cfg.restOff ? { rest_sec: 0 } : {}),
        ...(cfg.sgName ? { superset: cfg.sgName } : {}),
        ...(cfg.note ? { note: cfg.note } : {}),
      }
    }),
  }
}
