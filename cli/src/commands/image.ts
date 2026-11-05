import { getProjectRoot } from '../project-files'
import { validateAndAddImage } from '../utils/pending-attachments'

/**
 * Handle the /image command to attach an image file.
 * Usage: /image <path> [message]
 * Example: /image ./screenshot.png please analyze this
 *
 * Returns the optional message as transformedPrompt (empty string if none).
 * Errors are shown in the pending images banner with auto-remove.
 */
export function parseImageCommandArgs(args: string): {
  imagePath: string | null
  message: string
} {
  const text = args.trim()
  if (!text) return { imagePath: null, message: '' }
  const match =
    /^(?:"((?:\\.|[^"\\])*)"|'([^']*)'|([^"'\s]\S*))(?:\s+([\s\S]*))?$/.exec(
      text,
    )
  if (!match)
    throw new Error(
      'Usage: /image "path with spaces.png" [instruction]. Close the path quote before adding an instruction.',
    )
  return {
    imagePath:
      match[1] !== undefined
        ? match[1].replace(/\\(["\\])/g, '$1')
        : (match[2] ?? match[3] ?? null),
    message: match[4] ?? '',
  }
}

export async function handleImageCommand(args: string): Promise<string> {
  const { imagePath, message } = parseImageCommandArgs(args)

  if (imagePath) {
    await validateAndAddImage(imagePath, getProjectRoot())
  }

  return message
}
