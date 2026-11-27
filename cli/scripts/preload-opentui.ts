import { getNodeAssets } from '@opentui/core/node-assets'
import path from 'node:path'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Bun's reused test workers can observe the native package's asynchronous
// default export before initialization. Bind the installed asset directly,
// before any suite registers module mocks, and exercise the real FFI once.
const assets = getNodeAssets({
  platform: process.platform,
  arch: process.arch,
  ...(process.platform === 'linux' && process.env.OPENTUI_LIBC === 'musl'
    ? { libc: 'musl' as const }
    : {}),
})
const native = assets.find((asset) => /\.(so|dylib|dll)$/.test(asset.source))
if (!native)
  throw new Error('The installed OpenTUI native asset is unavailable')

// --isolate resets module state after preload, while worker environment is
// retained. Use OpenTUI's supported asset-root route in every fresh module
// instance, bypassing the asynchronous native-package default export.
if (!process.env.OTUI_ASSET_ROOT) {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.resolve('@opentui/core'))),
    '../..',
  )
  if (
    realpathSync(path.resolve(root, native.key)) !== realpathSync(native.source)
  ) {
    throw new Error(
      'OpenTUI test assets do not share the installed package root',
    )
  }
  process.env.OTUI_ASSET_ROOT = root
}

const { setRenderLibPath, SyntaxStyle, ResourceContext } = await import('@opentui/core')
setRenderLibPath(native.source)
const owner = new ResourceContext({ objectCapacity: 16, renderCellsMax: 1 })
try {
  const style = SyntaxStyle.fromStyles({}, owner)
  style.destroy()
} finally {
  owner.destroy()
}
