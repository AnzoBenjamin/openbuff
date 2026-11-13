import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  TOKEN_CALIBRATION_BAND_MAX,
  TOKEN_CALIBRATION_MAX_FACTOR,
  TOKEN_CALIBRATION_MIN_OBSERVATIONS,
  TOKEN_CALIBRATION_WINDOW,
  calibrationFamilyForModel,
  observedCalibrationFactor,
  recordTokenObservation,
  resetTokenCalibrationForTest,
  setTokenCalibrationStorePath,
  tokenCalibrationStatus,
} from '../token-calibration'
import { countTokens, tokenFudgeFactorForModel } from '../token-counter'

const MODEL_ANTHROPIC = 'anthropic/claude-opus-4-7'
const MODEL_OPENAI = 'openai/gpt-5.3'
const MODEL_GEMINI = 'google/gemini-3-pro'

describe('token-calibration', () => {
  afterEach(() => {
    setTokenCalibrationStorePath(undefined)
    resetTokenCalibrationForTest()
  })

  test('family keys mirror the tokenizer-family rules', () => {
    expect(calibrationFamilyForModel(MODEL_ANTHROPIC)).toBe('anthropic')
    expect(calibrationFamilyForModel(MODEL_OPENAI)).toBe('openai')
    expect(calibrationFamilyForModel(MODEL_GEMINI)).toBe('gemini')
    expect(calibrationFamilyForModel(undefined)).toBe('unknown')
  })

  test('no factor until the minimum observation count, then converges', () => {
    for (let i = 0; i < TOKEN_CALIBRATION_MIN_OBSERVATIONS - 1; i++) {
      recordTokenObservation(MODEL_ANTHROPIC, 100, 135)
    }
    expect(observedCalibrationFactor(MODEL_ANTHROPIC)).toBeUndefined()
    recordTokenObservation(MODEL_ANTHROPIC, 100, 135)
    expect(observedCalibrationFactor(MODEL_ANTHROPIC)).toBeCloseTo(1.35, 2)
  })

  test('families calibrate independently', () => {
    for (let i = 0; i < TOKEN_CALIBRATION_MIN_OBSERVATIONS; i++) {
      recordTokenObservation(MODEL_ANTHROPIC, 100, 135)
      recordTokenObservation(MODEL_OPENAI, 100, 100)
    }
    expect(observedCalibrationFactor(MODEL_ANTHROPIC)).toBeCloseTo(1.35, 2)
    expect(observedCalibrationFactor(MODEL_OPENAI)).toBeCloseTo(1.0, 2)
    expect(observedCalibrationFactor(MODEL_GEMINI)).toBeUndefined()
  })

  test('a wild observation is discarded on write and cannot swing the factor', () => {
    for (let i = 0; i < TOKEN_CALIBRATION_MIN_OBSERVATIONS - 1; i++) {
      recordTokenObservation(MODEL_OPENAI, 100, 102)
    }
    // One pathological observation (provider misreport): ratio 10x. It is
    // outside openai's credibility band, so SEC-TC-CALIBRATION-BAND-1(b)
    // rejects it at the write site instead of relying on the median to absorb
    // it — the window never carries a ratio that far from the static factor.
    recordTokenObservation(MODEL_OPENAI, 100, 1000)
    const status = tokenCalibrationStatus()
    expect(status.openai!.observations).toBe(
      TOKEN_CALIBRATION_MIN_OBSERVATIONS - 1,
    )
    // Only 7 credible observations remain, so the static factor still stands.
    expect(observedCalibrationFactor(MODEL_OPENAI)).toBeUndefined()
    // The estimator itself is unaffected by the rejected pair.
    expect(tokenFudgeFactorForModel(MODEL_OPENAI)).toBe(1)
  })

  test('the converged factor is a bounded CORRECTION around the static factor (SEC-TC-CALIBRATION-BAND-1)', () => {
    // Gemini's static factor is 1.1, so the correction band is [0.88, 1.375]:
    // a consistent, credible +25% divergence converges inside it...
    for (let i = 0; i < TOKEN_CALIBRATION_MIN_OBSERVATIONS; i++) {
      recordTokenObservation(MODEL_GEMINI, 100, 137)
    }
    const geminiFactor = observedCalibrationFactor(MODEL_GEMINI)!
    expect(geminiFactor).toBeCloseTo(1.37, 2)
    expect(geminiFactor).toBeLessThanOrEqual(1.1 * 1.25)
    // ...while extreme observations (a steered provider count) are not
    // credible at all: they never record, so the static factor stands instead
    // of the old free-running clamp at TOKEN_CALIBRATION_MAX_FACTOR.
    resetTokenCalibrationForTest()
    for (let i = 0; i < TOKEN_CALIBRATION_MIN_OBSERVATIONS; i++) {
      recordTokenObservation(MODEL_GEMINI, 100, 10000)
    }
    expect(observedCalibrationFactor(MODEL_GEMINI)).toBeUndefined()
    expect(TOKEN_CALIBRATION_MAX_FACTOR).toBeGreaterThan(1.375)
  })

  test('the observation window is bounded', () => {
    // Ratio 1.35 equals anthropic's static factor, so every pair clears the
    // credibility floor (downward corrections are not reachable from
    // observation data) and the bounded window is what caps the count.
    for (let i = 0; i < TOKEN_CALIBRATION_WINDOW + 20; i++) {
      recordTokenObservation(MODEL_ANTHROPIC, 100, 135)
    }
    const status = tokenCalibrationStatus()
    expect(status['anthropic']!.observations).toBe(TOKEN_CALIBRATION_WINDOW)
    // The surviving window is a bounded correction around the static factor:
    // it can never exceed the band ceiling (float-tolerant, since 1.35 * 1.25
    // is not exactly representable).
    expect(observedCalibrationFactor(MODEL_ANTHROPIC)).toBeLessThanOrEqual(
      1.35 * TOKEN_CALIBRATION_BAND_MAX + 1e-9,
    )
  })

  test('invalid observations are ignored', () => {
    recordTokenObservation(MODEL_OPENAI, 0, 100)
    recordTokenObservation(MODEL_OPENAI, 100, 0)
    recordTokenObservation(MODEL_OPENAI, Number.NaN, 100)
    expect(tokenCalibrationStatus()['openai']).toBeUndefined()
  })

  test('persistence: survives a store reset when attached to a file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'token-calib-'))
    try {
      const storePath = path.join(dir, 'token-calibration.json')
      setTokenCalibrationStorePath(storePath)
      // Ratio 1.4 sits inside anthropic's credibility band [1.35, 1.6875], so
      // the pairs persist and a fresh process reloads a converged factor.
      for (let i = 0; i < TOKEN_CALIBRATION_MIN_OBSERVATIONS; i++) {
        recordTokenObservation(MODEL_ANTHROPIC, 100, 140)
      }
      resetTokenCalibrationForTest() // simulate a fresh process
      setTokenCalibrationStorePath(storePath)
      expect(observedCalibrationFactor(MODEL_ANTHROPIC)).toBeCloseTo(1.4, 2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('each write records one observation and retains completed external writes', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'token-calib-merge-'))
    try {
      const storePath = path.join(dir, 'token-calibration.json')
      setTokenCalibrationStorePath(storePath)
      recordTokenObservation(MODEL_OPENAI, 100, 100)
      recordTokenObservation(MODEL_OPENAI, 100, 100)
      const external = JSON.parse(readFileSync(storePath, 'utf8'))
      expect(external.families.openai).toHaveLength(2)
      external.families.openai.push({ estimated: 100, actual: 110 })
      writeFileSync(storePath, JSON.stringify(external))
      recordTokenObservation(MODEL_OPENAI, 100, 120)
      const result = JSON.parse(readFileSync(storePath, 'utf8'))
      expect(result.families.openai).toEqual([
        { estimated: 100, actual: 100 },
        { estimated: 100, actual: 100 },
        { estimated: 100, actual: 110 },
        { estimated: 100, actual: 120 },
      ])
      expect(tokenCalibrationStatus().openai?.observations).toBe(4)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('malformed store file degrades to empty (fail-open)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'token-calib-bad-'))
    try {
      const storePath = path.join(dir, 'token-calibration.json')
      writeFileSync(storePath, '{not json', 'utf8')
      setTokenCalibrationStorePath(storePath)
      expect(observedCalibrationFactor(MODEL_OPENAI)).toBeUndefined()
      recordTokenObservation(MODEL_OPENAI, 100, 100)
      expect(tokenCalibrationStatus()['openai']!.observations).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the estimator consults the calibration factor once converged', () => {
    const text = 'def hello():\n    return "world"\n'.repeat(40)
    const staticEstimate = countTokens(text, MODEL_OPENAI) // factor 1.0
    // Record consistent 1.2x actuals until convergence.
    for (let i = 0; i < TOKEN_CALIBRATION_MIN_OBSERVATIONS; i++) {
      recordTokenObservation(MODEL_OPENAI, 100, 120)
    }
    const calibrated = countTokens(text, MODEL_OPENAI)
    expect(calibrated).toBeGreaterThan(staticEstimate * 1.1)
    expect(calibrated).toBeLessThan(staticEstimate * 1.3)
  })
})
