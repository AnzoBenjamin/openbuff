import { randomFillSync } from 'crypto'
import { mkdirSync, rmSync } from 'fs'
import os from 'os'
import path from 'path'

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Jimp } from 'jimp'

import { getProjectRoot, setProjectRoot } from '../../project-files'
import { calculateDisplaySize } from '../image-display'
import { processImageFile } from '../image-handler'

let TEST_DIR: string
let previousProjectRoot: string | undefined

beforeEach(async () => {
  TEST_DIR = path.join(
    os.tmpdir(),
    `temp-test-images-${process.pid}-${Date.now()}`,
  )
  mkdirSync(TEST_DIR, { recursive: true })
  // Create debug directory for logger
  mkdirSync(path.join(TEST_DIR, 'debug'), { recursive: true })

  try {
    previousProjectRoot = getProjectRoot()
  } catch {
    previousProjectRoot = undefined
  }

  // Set project root so logger doesn't throw
  setProjectRoot(TEST_DIR)

  // Create test images with known dimensions using Jimp
  // Wide image: 200x100 (2:1 aspect ratio)
  const wideImage = new Jimp({ width: 200, height: 100, color: 0xff0000ff })
  await wideImage.write(
    path.join(TEST_DIR, 'wide-200x100.png') as `${string}.${string}`,
  )

  // Tall image: 100x200 (1:2 aspect ratio)
  const tallImage = new Jimp({ width: 100, height: 200, color: 0x00ff00ff })
  await tallImage.write(
    path.join(TEST_DIR, 'tall-100x200.png') as `${string}.${string}`,
  )

  // Square image: 150x150 (1:1 aspect ratio)
  const squareImage = new Jimp({ width: 150, height: 150, color: 0x0000ffff })
  await squareImage.write(
    path.join(TEST_DIR, 'square-150x150.png') as `${string}.${string}`,
  )
})

afterEach(() => {
  // Always restore a live root before deleting TEST_DIR. If getProjectRoot()
  // threw in beforeEach, previousProjectRoot is unset and leaving TEST_DIR
  // installed would point the global root at a removed path.
  setProjectRoot(previousProjectRoot ?? process.cwd())
  try {
    rmSync(TEST_DIR, { recursive: true, force: true })
  } catch {
    // Ignore cleanup errors
  }
})

describe('Image Dimensions', () => {
  describe('processImageFile returns dimensions', () => {
    test('should return width and height for a wide image', async () => {
      // Use filename only since processImageFile resolves relative to cwd
      const result = await processImageFile('wide-200x100.png', TEST_DIR)

      expect(result.success).toBe(true)
      expect(result.imagePart).toBeDefined()
      expect(result.imagePart!.width).toBe(200)
      expect(result.imagePart!.height).toBe(100)
    })

    test('should return width and height for a tall image', async () => {
      const result = await processImageFile('tall-100x200.png', TEST_DIR)

      expect(result.success).toBe(true)
      expect(result.imagePart).toBeDefined()
      expect(result.imagePart!.width).toBe(100)
      expect(result.imagePart!.height).toBe(200)
    })

    test('should return width and height for a square image', async () => {
      const result = await processImageFile('square-150x150.png', TEST_DIR)

      expect(result.success).toBe(true)
      expect(result.imagePart).toBeDefined()
      expect(result.imagePart!.width).toBe(150)
      expect(result.imagePart!.height).toBe(150)
    })

    test('should return compressed dimensions when image is compressed', async () => {
      // Compression triggers on base64 size, not dimensions. A solid fill PNG
      // stays under MAX_IMAGE_BASE64_SIZE. Fill the bitmap once (no 2e6
      // setPixelColor loop) so the PNG exceeds the 1MB gate.
      const largeImage = new Jimp({ width: 2000, height: 1000 })
      randomFillSync(largeImage.bitmap.data)
      await largeImage.write(
        path.join(TEST_DIR, 'large-2000x1000.png') as `${string}.${string}`,
      )

      const result = await processImageFile('large-2000x1000.png', TEST_DIR)

      expect(result.success).toBe(true)
      expect(result.wasCompressed).toBe(true)
      expect(result.imagePart).toBeDefined()
      // First dimension limit is 1500; wide images scale width and keep 2:1
      expect(result.imagePart!.width).toBe(1500)
      expect(result.imagePart!.height).toBe(750)
    })
  })

  describe('calculateDisplaySize', () => {
    const CELL_ASPECT_RATIO = 2 // Terminal cells are ~2:1 height:width

    test('should scale wide image to fit available width while preserving aspect ratio', () => {
      const result = calculateDisplaySize({
        width: 200,
        height: 100,
        availableWidth: 80,
      })

      // 200x100 @ 80: ceil(200/15)=14 cells wide, floor(14/2/2)=3 tall
      expect(result).toEqual({ width: 14, height: 3 })
    })

    test('should scale tall image appropriately', () => {
      const result = calculateDisplaySize({
        width: 100,
        height: 200,
        availableWidth: 80,
      })

      expect(result).toEqual({ width: 7, height: 7 })
      // Tall images should have larger height relative to width
      expect(result.height).toBeGreaterThanOrEqual(
        result.width / CELL_ASPECT_RATIO,
      )
    })

    test('should handle square images', () => {
      const result = calculateDisplaySize({
        width: 150,
        height: 150,
        availableWidth: 80,
      })

      expect(result).toEqual({ width: 10, height: 5 })
    })

    test('should use fallback when dimensions are not provided', () => {
      const result = calculateDisplaySize({
        availableWidth: 80,
      })

      // Fallback should still return reasonable values
      expect(result.width).toBeLessThanOrEqual(80)
      expect(result.width).toBeGreaterThan(0)
      expect(result.height).toBeGreaterThan(0)
    })

    test('should use fallback when width is 0', () => {
      const result = calculateDisplaySize({
        width: 0,
        height: 100,
        availableWidth: 80,
      })

      expect(result.width).toBeGreaterThan(0)
      expect(result.height).toBeGreaterThan(0)
    })

    test('should use fallback when height is 0', () => {
      const result = calculateDisplaySize({
        width: 100,
        height: 0,
        availableWidth: 80,
      })

      expect(result.width).toBeGreaterThan(0)
      expect(result.height).toBeGreaterThan(0)
    })

    test('should respect minimum display size', () => {
      const result = calculateDisplaySize({
        width: 1,
        height: 1,
        availableWidth: 80,
      })

      // Even tiny images should have at least 1 cell
      expect(result.width).toBeGreaterThanOrEqual(1)
      expect(result.height).toBeGreaterThanOrEqual(1)
    })

    test('should handle very wide available width', () => {
      const result = calculateDisplaySize({
        width: 100,
        height: 100,
        availableWidth: 200,
      })

      // Should not blow up image beyond reasonable size
      expect(result.width).toBeLessThanOrEqual(100) // Don't exceed original
      expect(result.height).toBeGreaterThan(0)
    })

    test('should handle narrow available width', () => {
      const result = calculateDisplaySize({
        width: 1000,
        height: 500,
        availableWidth: 20,
      })

      expect(result.width).toBeLessThanOrEqual(20)
      expect(result.height).toBeGreaterThan(0)
    })
  })
})
