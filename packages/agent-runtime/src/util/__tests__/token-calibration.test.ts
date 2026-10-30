import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
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
import { countTokens } from '../token-counter'

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

  test('median with outlier drop: a wild observation cannot swing the factor', () => {
    for (let i = 0; i < TOKEN_CALIBRATION_MIN_OBSERVATIONS - 1; i++) {
      recordTokenObservation(MODEL_OPENAI, 100, 102)
    }
    // One pathological observation (provider misreport): ratio 10x.
    recordTokenObservation(MODEL_OPENAI, 100, 1000)
    expect(observedCalibrationFactor(MODEL_OPENAI)).toBeCloseTo(1.02, 2)
  })

  test('converged factor is clamped to the sane band', () => {
    for (let i = 0; i < TOKEN_CALIBRATION_MIN_OBSERVATIONS; i++) {
      recordTokenObservation(MODEL_GEMINI, 100, 100) // would be 1.0...
    }
    // extreme consistent observations clamp rather than extrapolate
    resetTokenCalibrationForTest()
    for (let i = 0; i < TOKEN_CALIBRATION_MIN_OBSERVATIONS; i++) {
      recordTokenObservation(MODEL_GEMINI, 100, 10000)
    }
    expect(observedCalibrationFactor(MODEL_GEMINI)).toBe(TOKEN_CALIBRATION_MAX_FACTOR)
  })

  test('the observation window is bounded', () => {
    for (let i = 0; i < TOKEN_CALIBRATION_WINDOW + 20; i++) {
      recordTokenObservation(MODEL_ANTHROPIC, 100, 100 + i)
    }
    const status = tokenCalibrationStatus()
    expect(status['anthropic']!.observations).toBe(TOKEN_CALIBRATION_WINDOW)
    // The newest observations dominate the median: after appending 40 fresh
    // 1.0-ratio observations past a stretch of rising ones, the window holds
    // only the last 40 — all ratio 1.0..~1.95 — so the factor reflects them.
    expect(observedCalibrationFactor(MODEL_ANTHROPIC)).toBeLessThan(2.0)
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
      for (let i = 0; i < TOKEN_CALIBRATION_MIN_OBSERVATIONS; i++) {
        recordTokenObservation(MODEL_ANTHROPIC, 100, 120)
      }
      resetTokenCalibrationForTest() // simulate a fresh process
      setTokenCalibrationStorePath(storePath)
      expect(observedCalibrationFactor(MODEL_ANTHROPIC)).toBeCloseTo(1.2, 2)
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
    // Record consistent 2x actuals until convergence.
    for (let i = 0; i < TOKEN_CALIBRATION_MIN_OBSERVATIONS; i++) {
      recordTokenObservation(MODEL_OPENAI, 100, 200)
    }
    const calibrated = countTokens(text, MODEL_OPENAI)
    expect(calibrated).toBeGreaterThan(staticEstimate * 1.8)
    expect(calibrated).toBeLessThan(staticEstimate * 2.2)
  })
})
