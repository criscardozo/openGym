import { describe, test, expect } from 'vitest'
import { buildRoutine, applyRoutine, routineView } from './save-routine.js'

const profile = (extra = {}) => ({ unit: 'kg', routines: [{ id: 'r-old', name: 'Starter', emoji: '💪', prog: 'double', ex: [{ id: '0739', sets: 3, reps: 10, weight: 80, inc: 5 }] }], week: { 1: ['r-old'], 3: ['r-old', 'r-x'] }, customEx: [], ...extra })
const build = (S, input, opts) => buildRoutine(S, input, opts)

describe('buildRoutine', () => {
  test('reps, a hold and cardio, each starting from what picking it in the editor gives', () => {
    const b = build(profile(), { name: 'Day A', exercises: [
      { exercise: 'leg press', sets: 3, reps: 12, restSec: 90 },
      { exercise: '0463', sets: 3, seconds: 30 },
      { exercise: 'treadmill walk', minutes: 15, speedKmh: 6, incline: 4 },
    ] })
    expect(b.problems).toBeUndefined()
    const [press, plank, walk] = b.routine.ex
    expect(press).toEqual({ id: '0739', sets: 3, reps: 12, weight: 0, mode: 'reps', restSec: 90 })
    expect(plank).toMatchObject({ id: '0463', sets: 3, sec: 30, mode: 'time' })
    expect(walk).toEqual({ id: '3666', sets: 1, min: 15, speed: 6, incline: 4 })
    expect(b.routine.name).toBe('Day A')
    expect(b.routine.id).toBeTruthy()
  })

  test('per-side reps are stored as both sides together, a range keeps its bottom', () => {
    const b = build(profile(), { name: 'Core', exercises: [
      { exercise: '0276', sets: 3, reps: 8, perSide: true },
      { exercise: 'cable curl', reps: 12, repsMin: 8 },
    ] })
    expect(b.routine.ex[0]).toMatchObject({ side: true, reps: 16 })
    expect(b.routine.ex[1]).toMatchObject({ reps: 12, repsMin: 8 })
    const v = routineView(profile(), b)
    expect(v.exercises[0].summary).toContain('8/side')
    expect(v.exercises[1].summary).toContain('8–12')
  })

  test('a weight in the other unit is converted to the profile\'s', () => {
    const b = build(profile(), { name: 'Arms', unit: 'lb', exercises: [{ exercise: 'cable curl', reps: 10, weight: 50 }] })
    expect(b.routine.ex[0].weight).toBe(22.7)
  })

  test('neighbours sharing a label become one named superset; split or lone labels are problems', () => {
    const ok = build(profile(), { name: 'Arms', exercises: [
      { exercise: 'cable curl', superset: 'Arms' }, { exercise: 'cable pushdown', superset: 'Arms' },
    ] })
    expect(ok.routine.ex[0].sg).toBeTruthy()
    expect(ok.routine.ex[0].sg).toBe(ok.routine.ex[1].sg)
    expect(ok.routine.ex.map(e => e.sgName)).toEqual(['Arms', 'Arms'])
    const split = build(profile(), { name: 'Arms', exercises: [
      { exercise: 'cable curl', superset: 'A' }, { exercise: 'leg press' }, { exercise: 'cable pushdown', superset: 'A' },
    ] })
    expect(split.problems[0].problem).toMatch(/next to each other/)
    const lone = build(profile(), { name: 'Arms', exercises: [{ exercise: 'cable curl', superset: 'A' }] })
    expect(lone.problems[0].problem).toMatch(/at least two/)
  })

  test('an ambiguous name comes back with candidates, and nothing is built', () => {
    const b = build(profile(), { name: 'Day A', exercises: [{ exercise: 'lever chest press', reps: 12 }] })
    expect(b.routine).toBeUndefined()
    expect(b.problems[0].candidates.map(c => c.id)).toEqual(expect.arrayContaining(['0576', '0577']))
  })

  test('the wrong kind of numbers for an exercise is a problem', () => {
    expect(build(profile(), { name: 'X', exercises: [{ exercise: 'treadmill walk', reps: 10 }] }).problems[0].problem).toMatch(/cardio/)
    expect(build(profile(), { name: 'X', exercises: [{ exercise: 'leg press', minutes: 10 }] }).problems[0].problem).toMatch(/cardio exercise/)
    expect(build(profile(), { name: 'X', exercises: [{ exercise: 'leg press', reps: 10, seconds: 30 }] }).problems[0].problem).toMatch(/one kind/)
    expect(build(profile(), { name: 'X', exercises: [{ exercise: 'leg press', reps: 10, repsMin: 12 }] }).problems[0].field).toBe('exercises[0].repsMin')
  })

  test('a name the profile already uses is refused unless replacing that routine or told to', () => {
    const S = profile()
    const again = build(S, { name: 'starter', exercises: [{ exercise: 'leg press' }] })
    expect(again.problems[0]).toMatchObject({ field: 'name', existing: { id: 'r-old' } })
    expect(build(S, { name: 'Starter', allowSameName: true, exercises: [{ exercise: 'leg press' }] }).problems).toBeUndefined()
    expect(build(S, { routineId: 'r-old', exercises: [{ exercise: 'leg press' }] }).problems).toBeUndefined()
  })

  test('a replaced routine keeps its id, emoji and progression rule; its exercises are the new list', () => {
    const b = build(profile(), { routineId: 'r-old', exercises: [{ exercise: 'leg extension', reps: 12 }] })
    expect(b.routine).toMatchObject({ id: 'r-old', name: 'Starter', emoji: '💪', prog: 'double' })
    expect(b.routine.ex.map(e => e.id)).toEqual(['0585'])
    expect(build(profile(), { routineId: 'nope', exercises: [{ exercise: 'leg press' }] }).problems[0].field).toBe('routineId')
  })

  test('a confirmed new exercise is created with the id log_workout would give it', () => {
    const b = build(profile(), { name: 'Odd', exercises: [{ exercise: 'Zorbatron press', createCustom: true, bodyPart: 'chest', reps: 10 }] })
    expect(b.customEx).toHaveLength(1)
    expect(b.customEx[0]).toMatchObject({ n: 'Zorbatron press', bp: 'chest', custom: true })
    expect(b.routine.ex[0].id).toBe(b.customEx[0].id)
    expect(routineView(profile(), b).exercises[0].new_custom_exercise).toBe(true)
  })
})

describe('applyRoutine', () => {
  test('a new routine goes at the end, stamped, and onto the weekdays beside what they hold', () => {
    const S = profile()
    const b = build(S, { name: 'Day A', exercises: [{ exercise: 'leg press' }] })
    const out = applyRoutine(S, b, { weekdays: [1, 4], now: 1000 })
    expect(out.replaced).toBe(false)
    expect(S.routines.map(r => r.name)).toEqual(['Starter', 'Day A'])
    expect(S.routines[1]._ts).toBe(1000)
    expect(S.routines[0]._ts).toBeUndefined()
    expect(S.week).toEqual({ 1: ['r-old', b.routine.id], 3: ['r-old', 'r-x'], 4: [b.routine.id] })
  })

  test('exclusive weekdays hold only the routine', () => {
    const S = profile()
    const b = build(S, { name: 'Day A', exercises: [{ exercise: 'leg press' }] })
    applyRoutine(S, b, { weekdays: [1, 3], exclusive: true })
    expect(S.week).toEqual({ 1: [b.routine.id], 3: [b.routine.id] })
  })

  test('a replacement stays in place, and given weekdays it leaves the others', () => {
    const S = profile()
    const b = build(S, { routineId: 'r-old', exercises: [{ exercise: 'leg extension' }] })
    const out = applyRoutine(S, b, { weekdays: [5], now: 2000 })
    expect(out.replaced).toBe(true)
    expect(S.routines).toHaveLength(1)
    expect(S.routines[0]).toMatchObject({ id: 'r-old', _ts: 2000 })
    expect(S.routines[0]._f.ex).toBe(2000)
    expect(S.week).toEqual({ 3: ['r-x'], 5: ['r-old'] })
  })

  test('without weekdays the weekly plan is not touched', () => {
    const S = profile()
    const week = structuredClone(S.week)
    applyRoutine(S, build(S, { name: 'Day B', exercises: [{ exercise: 'leg press' }] }))
    expect(S.week).toEqual(week)
  })

  test('new custom exercises join the profile once', () => {
    const S = profile()
    const b = build(S, { name: 'Odd', exercises: [{ exercise: 'Zorbatron press', createCustom: true, bodyPart: 'chest' }] })
    applyRoutine(S, b, { now: 3000 })
    expect(S.customEx).toHaveLength(1)
    expect(S.customEx[0]._ts).toBe(3000)
  })
})
