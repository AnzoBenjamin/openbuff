import { getProjectRoot } from '../project-files'
import { getSystemMessage } from '../utils/message-history'
import {
  isTurnBisectionRunning,
  listTurnSnapshots,
  previewTurnRestore,
  restorePreviewedTurn,
  type RestorePreview,
} from '../utils/turn-snapshots'
import type { RouterParams } from './command-registry'

const previews = new Map<string, RestorePreview>()
let previewGeneration = 0

export async function handleSnapshotRestoreCommand(
  params: RouterParams,
  args: string,
  undo = false,
): Promise<void> {
  const append = (text: string) =>
    params.setMessages((messages) => [...messages, getSystemMessage(text)])
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  const generation = ++previewGeneration
  if (tokens[0] === 'cancel') {
    const preview = previews.get(tokens[1] ?? '')
    if (preview && preview.projectRoot === getProjectRoot())
      previews.delete(preview.token)
    append(
      '/restore: preview cancelled. No files were changed. Run /restore <snapshot> to reopen a preview.',
    )
    return
  }
  if (
    params.isStreaming ||
    params.streamMessageIdRef.current ||
    params.isChainInProgressRef.current ||
    isTurnBisectionRunning()
  ) {
    append(
      '/restore: wait for the running turn or bisection to finish before previewing or restoring tracked files.',
    )
    return
  }
  if (tokens[1] === '--apply') {
    const preview = previews.get(tokens[2] ?? '')
    if (
      !preview ||
      preview.sha !== tokens[0] ||
      preview.projectRoot !== getProjectRoot() ||
      tokens.length !== 3
    ) {
      append(
        '/restore: this apply action has no matching preview in the current project. Run /restore <snapshot> to inspect again.',
      )
      return
    }
    const result = await restorePreviewedTurn(preview)
    if (result.status === 'restored') {
      previews.delete(preview.token)
      append(
        `/restore: materialized target snapshot ${result.sha}; HEAD and the real index are unchanged. Files absent from the target are not deleted. Snapshot history remains available through /bisect-turn list.`,
      )
    } else
      append(
        `/restore: ${result.status === 'error' ? result.message : result.status}. The preview remains available; inspect again before retrying.`,
      )
    return
  }
  if ((!undo && tokens.length !== 1) || (undo && tokens.length)) {
    append(
      'Usage: /restore <snapshot SHA or 1-based index> · /undo-turn previews the previous snapshot. Restore requires the displayed apply action; /restore cancel <token> changes no files.',
    )
    return
  }
  append('/restore: capturing target and current tracked-file differences...')
  const root = getProjectRoot()
  const snapshots = await listTurnSnapshots({ projectRoot: root })
  const target = undo
    ? snapshots[1]?.sha
    : /^\d+$/.test(tokens[0] ?? '') && Number.isSafeInteger(Number(tokens[0]))
      ? snapshots[Number(tokens[0]) - 1]?.sha
      : tokens[0]
  if (!target) {
    append(
      '/restore: no snapshot matches that target. Use /bisect-turn list to browse retained snapshots.',
    )
    return
  }
  const preview = await previewTurnRestore(target, { projectRoot: root })
  if (generation !== previewGeneration || root !== getProjectRoot()) return
  if (preview.status !== 'ready') {
    append(
      `/restore: ${preview.status === 'error' ? preview.message : preview.status}. No files were changed.`,
    )
    return
  }
  // Only the most recent preview can be applied; older displayed actions expire.
  previews.clear()
  previews.set(preview.token, preview)
  append(
    [
      `Restore preview · target ${preview.sha}`,
      `Project: ${preview.projectRoot}`,
      `${preview.totalFiles} current tracked-file differences; showing ${preview.files.length} paths.`,
      'This materializes tracked files present in the target; files absent from the target are not deleted. HEAD, the real index and untracked files are unchanged. Untracked target-path collisions prevent restore.',
      'The diff reads from current content to target content. Target-absent paths shown in the comparison are retained by restore.',
      ...preview.files.map((file) => `- ${file}`),
      '',
      preview.diff || 'No tracked-file differences.',
      ...(preview.detailTruncated
        ? [
            'Preview detail is bounded; inspect the target with git diff <snapshot> before applying if more detail is required.',
          ]
        : []),
      '',
      `Restore these changes: /restore ${preview.sha} --apply ${preview.token}`,
      `Back / cancel preview: /restore cancel ${preview.token} (no files change).`,
      'The apply action is bound to this target and current tracked-file content; changed files require a fresh preview.',
    ].join('\n'),
  )
}
