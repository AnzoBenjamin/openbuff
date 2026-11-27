import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import path from 'node:path'

import { get3dAssetFormat } from '@codebuff/common/util/file'

import { executionRefusal, ExecutionRefusalError, isExecutionRefusalError } from '../services/execution-launch'
import { resolveFilePathForFileSystemOperation } from './path-utils'
import { readImages } from './read-image'
import { prune3dMutationArtifacts } from './3d-artifact-retention'
export {
  MUTATION_RETAINED_ATTEMPT_ARTIFACTS,
  MUTATION_ARTIFACT_PRUNE_MAX_STATS,
  MUTATION_ARTIFACT_RETENTION_MS,
  MUTATION_PRUNE_STRIDE_EDITS,
} from './3d-artifact-retention'
import { isReadPathBlocked } from './read-policy'

import type { CodebuffToolOutput } from '@codebuff/common/tools/list'
import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { FileFilter } from './read-files'
import type { ExecutionAdapterContext, Refusal } from '@codebuff/common/types/contracts/execution-context'
import type { ChildProcess } from 'node:child_process'

const MAX_INSPECT_BYTES = 256 * 1024 * 1024
const MAX_TEXT_ASSET_BYTES = 24 * 1024 * 1024
const BLENDER_TIMEOUT_MS = 120_000
const BLENDER_JSON_MARKER = 'OPENBUFF_3D_JSON:'
/**
 * Suffixes of the files one edit attempt writes. Each name is
 * `<attemptId><suffix>`, so a release tells THIS attempt's files from a sibling
 * attempt's by prefix alone (see `tryReleaseArtifactDir`) without keeping a
 * fixed cleanup list in sync with the write path.
 */
const ARTIFACT_WORKING_COPY_SUFFIX = '.blend'
const ARTIFACT_EDIT_SCRIPT_SUFFIX = '.py'
const ARTIFACT_OPERATIONS_SUFFIX = '.json'
/**
 * Cap on the serialized operations JSON this tool will WRITE TO DISK.
 *
 * The operations array no longer crosses to Blender as one env var: it is
 * written to `operations.json` next to the edit script and Blender is handed
 * only the short PATH via OPENBUFF_3D_OPERATIONS_PATH. That is a MECHANISM
 * change and is described only as such: the payload stops being an env string,
 * so the OS per-env-string ceiling is no longer on its path.
 *
 * The value is deliberately UNCHANGED by that mechanism change. Moving the
 * payload to a file removes the env-ceiling pressure that would have justified
 * a larger bound, and no measurement supports accepting a bigger payload, so
 * the previous 100_000-char sanity bound stands: an unmeasured cap raise is not
 * shipped, and nothing auto-splits a larger payload. It exists so a runaway
 * operations array fails with one clear, actionable message instead of writing
 * an enormous artifact file. `__tests__/3d-assets.test.ts` pins the below/at/2x
 * behavior against this value.
 */
export const MAX_OPERATIONS_FILE_CHARS = 100_000

type JsonRecord = Record<string, unknown>

type AssetReceipt = {
  path: string
  sourcePath: string
  sourceHash: string
  artifactHash: string
  mediaType: string
  dimensions?: { width: number; height: number }
  producer: string
  createdAt: string
  view?: string
  mode?: string
}

function collectSceneConcepts(value: unknown): string[] {
  const concepts = new Set<string>()
  const visit = (entry: unknown, key = ''): void => {
    if (concepts.size >= 200) return
    if (typeof entry === 'string') {
      if (
        entry.length > 0 &&
        entry.length <= 160 &&
        /name|material|object|collection|camera|light|action|animation|image|mesh/i.test(
          key,
        )
      ) {
        concepts.add(entry)
      }
      return
    }
    if (Array.isArray(entry)) {
      for (const item of entry.slice(0, 1_000)) visit(item, key)
      return
    }
    if (entry && typeof entry === 'object') {
      for (const [childKey, child] of Object.entries(entry)) {
        visit(child, childKey)
      }
    }
  }
  visit(value)
  return [...concepts]
}

const BLENDER_INSPECT_SCRIPT = String.raw`
import bpy, json, os

def vec(value):
    return [round(float(v), 6) for v in value]

def bbox(obj):
    if not getattr(obj, "bound_box", None):
        return None
    points = [obj.matrix_world @ __import__('mathutils').Vector(corner) for corner in obj.bound_box]
    return {"min": vec([min(p[i] for p in points) for i in range(3)]), "max": vec([max(p[i] for p in points) for i in range(3)])}

objects = []
for obj in list(bpy.context.scene.objects)[:1000]:
    data = {
        "name": obj.name,
        "type": obj.type,
        "location": vec(obj.location),
        "rotationEuler": vec(obj.rotation_euler),
        "scale": vec(obj.scale),
        "boundingBox": bbox(obj),
        "modifiers": [modifier.type for modifier in obj.modifiers],
        "materials": [slot.material.name for slot in obj.material_slots if slot.material],
    }
    if obj.type == 'MESH' and obj.data:
        data["mesh"] = {"vertices": len(obj.data.vertices), "edges": len(obj.data.edges), "polygons": len(obj.data.polygons)}
    objects.append(data)

images = []
for image in bpy.data.images:
    if image.source == 'FILE':
        absolute_path = bpy.path.abspath(image.filepath)
        images.append({"name": image.name, "path": absolute_path, "packed": image.packed_file is not None, "missing": image.packed_file is None and not os.path.exists(absolute_path)})

scene = bpy.context.scene
result = {
    "objects": objects,
    "collections": [collection.name for collection in list(bpy.data.collections)[:1000]],
    "materials": [material.name for material in list(bpy.data.materials)[:1000]],
    "images": images,
    "missingDependencies": [image["path"] for image in images if image["missing"]],
    "cameras": [camera.name for camera in list(bpy.data.cameras)[:1000]],
    "lights": [{"name": light.name, "type": light.type, "energy": light.energy} for light in list(bpy.data.lights)[:1000]],
    "armatures": [armature.name for armature in list(bpy.data.armatures)[:1000]],
    "actions": [{"name": action.name, "frameRange": vec(action.frame_range)} for action in list(bpy.data.actions)[:1000]],
    "frameRange": [scene.frame_start, scene.frame_end],
    "render": {"engine": scene.render.engine, "resolution": [scene.render.resolution_x, scene.render.resolution_y], "fps": scene.render.fps},
    "activeCamera": scene.camera.name if scene.camera else None,
}
print("${BLENDER_JSON_MARKER}" + json.dumps(result, separators=(',', ':')))
`

const BLENDER_IMPORT_SCRIPT = String.raw`
import bpy, os

source_path = os.environ['OPENBUFF_3D_SOURCE_PATH']
source_format = os.environ['OPENBUFF_3D_SOURCE_FORMAT']
bpy.ops.wm.read_factory_settings(use_empty=True)
if source_format == 'fbx':
    if hasattr(bpy.ops.wm, 'fbx_import'):
        bpy.ops.wm.fbx_import(filepath=source_path)
    else:
        bpy.ops.import_scene.fbx(filepath=source_path)
elif source_format == 'dae':
    if hasattr(bpy.ops.wm, 'collada_import'):
        bpy.ops.wm.collada_import(filepath=source_path)
    else:
        bpy.ops.wm.collada_import(filepath=source_path)
elif source_format == 'stl':
    if hasattr(bpy.ops.wm, 'stl_import'):
        bpy.ops.wm.stl_import(filepath=source_path)
    else:
        bpy.ops.import_mesh.stl(filepath=source_path)
elif source_format == 'ply':
    if hasattr(bpy.ops.wm, 'ply_import'):
        bpy.ops.wm.ply_import(filepath=source_path)
    else:
        bpy.ops.import_mesh.ply(filepath=source_path)
elif source_format in ('usd', 'usda', 'usdc', 'usdz'):
    bpy.ops.wm.usd_import(filepath=source_path)
else:
    raise ValueError('Blender importer unavailable for .' + source_format)
`

const BLENDER_IMPORT_AND_INSPECT_SCRIPT =
  BLENDER_IMPORT_SCRIPT + BLENDER_INSPECT_SCRIPT

const BLENDER_PREVIEW_SCRIPT = String.raw`
import bpy, math, os
from mathutils import Vector

output_dir = os.environ['OPENBUFF_3D_OUTPUT_DIR']
views_csv = os.environ['OPENBUFF_3D_VIEWS']
mode = os.environ['OPENBUFF_3D_MODE']
width = os.environ['OPENBUFF_3D_WIDTH']
height = os.environ['OPENBUFF_3D_HEIGHT']
views = views_csv.split(',')
scene = bpy.context.scene
scene.render.image_settings.file_format = 'PNG'
scene.render.resolution_x = int(width)
scene.render.resolution_y = int(height)
scene.render.resolution_percentage = 100
scene.render.film_transparent = False
scene.world.color = (0.055, 0.055, 0.055)

mesh_objects = [obj for obj in scene.objects if obj.type == 'MESH']
points = [obj.matrix_world @ Vector(corner) for obj in mesh_objects for corner in obj.bound_box]
if points:
    low = Vector([min(p[i] for p in points) for i in range(3)])
    high = Vector([max(p[i] for p in points) for i in range(3)])
    center = (low + high) / 2
    radius = max((high - low).length / 2, 0.5)
else:
    center, radius = Vector((0, 0, 0)), 2.0

original_camera = scene.camera
camera_data = bpy.data.cameras.new('OpenbuffPreviewCamera')
camera = bpy.data.objects.new('OpenbuffPreviewCamera', camera_data)
scene.collection.objects.link(camera)
scene.camera = camera
camera.data.lens = 50

def point_camera(location):
    camera.location = location
    camera.rotation_euler = (center - location).to_track_quat('-Z', 'Y').to_euler()

scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = 16
light_data = bpy.data.lights.new('OpenbuffPreviewKey', type='AREA')
light_data.energy = 1200
light_data.shape = 'DISK'
light_data.size = max(radius, 1.0)
light = bpy.data.objects.new('OpenbuffPreviewKey', light_data)
scene.collection.objects.link(light)
light.location = center + Vector((radius, -radius, radius * 2))
light.rotation_euler = (center - light.location).to_track_quat('-Z', 'Y').to_euler()
if mode == 'clay':
    clay_material = bpy.data.materials.new('OpenbuffClay')
    clay_material.diffuse_color = (0.62, 0.66, 0.70, 1.0)
    for obj in mesh_objects:
        obj.data.materials.clear()
        obj.data.materials.append(clay_material)
elif mode == 'wireframe':
    for obj in mesh_objects:
        wire = obj.modifiers.new('OpenbuffWireframe', 'WIREFRAME')
        wire.thickness = max(radius * 0.005, 0.001)

directions = {
    'perspective': Vector((1.5, -1.5, 1.15)),
    'front': Vector((0, -1, 0)),
    'side': Vector((1, 0, 0)),
    'top': Vector((0, 0, 1)),
    'camera': None,
}
distance = radius * 3.2
for view in views:
    if view == 'camera' and original_camera:
        scene.camera = original_camera
    else:
        scene.camera = camera
        direction = directions.get(view) or directions['perspective']
        point_camera(center + direction.normalized() * distance)
    scene.render.filepath = output_dir + '/' + view + '-' + mode + '.png'
    bpy.ops.render.render(write_still=True)
`

const BLENDER_EDIT_SCRIPT = String.raw`
import bpy, json, math, os

with open(os.environ['OPENBUFF_3D_OPERATIONS_PATH'], 'r', encoding='utf-8') as operations_file:
    operations = json.load(operations_file)
changed = []
for operation in operations:
    kind = operation['type']
    if kind == 'rename_object':
        obj = bpy.data.objects.get(operation['object'])
        if obj is None:
            raise ValueError('Object not found: ' + operation['object'])
        old = obj.name
        obj.name = operation['new_name']
        changed.append({'type': kind, 'before': old, 'after': obj.name})
    elif kind == 'set_object_transform':
        obj = bpy.data.objects.get(operation['object'])
        if obj is None:
            raise ValueError('Object not found: ' + operation['object'])
        if 'location' in operation:
            obj.location = operation['location']
        if 'rotation_degrees' in operation:
            obj.rotation_euler = [math.radians(value) for value in operation['rotation_degrees']]
        if 'scale' in operation:
            obj.scale = operation['scale']
        changed.append({'type': kind, 'object': obj.name})
    elif kind == 'set_render_resolution':
        scene = bpy.context.scene
        scene.render.resolution_x = operation['width']
        scene.render.resolution_y = operation['height']
        scene.render.resolution_percentage = operation.get('percentage', 100)
        changed.append({'type': kind})
    elif kind == 'set_frame_range':
        scene = bpy.context.scene
        scene.frame_start = operation['start']
        scene.frame_end = operation['end']
        changed.append({'type': kind})
    else:
        raise ValueError('Unsupported operation: ' + str(kind))

bpy.ops.wm.save_as_mainfile(filepath=bpy.data.filepath, check_existing=False)
print("${BLENDER_JSON_MARKER}" + json.dumps({'changed': changed}, separators=(',', ':')))
`

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function jsonOutput<T extends 'inspect_3d_asset' | 'render_3d_preview'>(
  value: JsonRecord,
): CodebuffToolOutput<T> {
  return [{ type: 'json', value }] as CodebuffToolOutput<T>
}

/**
 * Result of one Blender invocation.
 *
 * A success shape carries the process `exitCode` EXPLICITLY so a caller does not
 * have to infer "the artifact is trustworthy" from "the process ran". Every
 * non-zero exit and every spawn error is mapped to the failure shape below, so
 * `exitCode: 0` here means a clean exit that the edit path can require before it
 * reads or commits the working copy.
 */
type BlenderResult =
  | { ok: true; stdout: string; exitCode: 0 }
  | { ok: false; error: string; executionRefusal?: Refusal }

function blenderExecution(
  context: ExecutionAdapterContext | undefined,
  durationMs: number,
): ExecutionAdapterContext | undefined {
  if (!context) return undefined
  const derived = context.execution.derive({
    memoKey: 'blender.action',
    limit: { kind: 'finite', durationMs },
  })
  if (!derived.ok) throw new ExecutionRefusalError(derived)
  return {
    ...context,
    execution: derived.value,
    signal: derived.value.signal ?? context.signal,
  }
}

async function runBlender(
  args: string[],
  timeout = BLENDER_TIMEOUT_MS,
  environment: Record<string, string> = {},
  signal?: AbortSignal,
  execution?: ExecutionAdapterContext,
  branchId = 'blender.inspect-blend',
  cwd?: string,
): Promise<BlenderResult> {
  if (signal?.aborted) {
    return { ok: false, error: 'Blender operation cancelled.' }
  }
  if (!execution) {
    const refusal = executionRefusal('unavailable', 'Captured Blender execution context is unavailable')
    return { ok: false, error: refusal.cause, executionRefusal: refusal }
  }
  const prepared = execution.execution.prepareTarget({
    target: {
      executable: 'blender',
      argv: ['--disable-autoexec', ...args],
      cwd: cwd ?? execution.projectRoot,
      projectRoot: execution.projectRoot,
      allowedPaths: execution.allowedPaths,
      mode: execution.mode,
      processType: 'SYNC',
      profile: execution.profile,
      family: 'blender',
      branchId,
      environmentOverlay: environment,
      adapterOptions: {
        runtime: 'node',
        shell: false,
        stdio: 'ignore,pipe,pipe',
        windowsHide: true,
      },
    },
  })
  if (!prepared.ok)
    return { ok: false, error: prepared.cause, executionRefusal: prepared }
  const admission = await prepared.value.admit()
  if (!admission.ok)
    return { ok: false, error: admission.cause, executionRefusal: admission }
  return new Promise((resolve) => {
    const dispatched = prepared.value.dispatchNow(
      admission.value.permit,
      (input, observer) => {
        const child = (execution.spawn ?? spawn)(
          input.executable,
          input.argv,
          {
            cwd: input.cwd,
            env: input.env,
            signal: input.resourceSignal,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          },
        )
        child.once('spawn', () => {
          let failure: string | undefined
          if (
            typeof child.pid === 'number' &&
            Number.isInteger(child.pid) &&
            child.pid > 0
          ) {
            const observed = observer.spawnObserved({
              source: 'node-spawn-event',
              pid: child.pid,
            })
            if (!observed.ok) failure = observed.cause
          } else {
            observer.failure({
              source: 'adapter-observation-error',
              cause: 'Blender child has no valid runtime PID',
            })
            failure = 'Blender child has no valid runtime PID'
          }
          if (failure) {
            stop(failure)
            finish({ ok: false, error: failure })
          }
        })
        child.on('error', (error: NodeJS.ErrnoException) =>
          observer.failure({
            source: 'node-error-event',
            errorCode: error.code,
            cause: error.message,
          }),
        )
        return child
      },
    )
    if (!dispatched.ok) {
      resolve({
        ok: false,
        error: dispatched.cause,
        ...(dispatched.reason === 'dispatch-failed' ? {} : { executionRefusal: dispatched }),
      })
      return
    }
    const child = dispatched.value.handle
    const maxOutputBytes = 8 * 1024 * 1024
    // Separate stdout/stderr buffers: the OPENBUFF_3D_JSON: marker is printed
    // on stdout only, so stderr noise interleaved into one merged buffer can
    // bury or corrupt the marker line the JSON parse slices after it.
    let stdout = ''
    let stderr = ''
    let outputBytes = 0
    let forcedError: string | undefined
    let settled = false

    const finish = (result: BlenderResult) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const stop = (message: string) => {
      if (forcedError) return
      forcedError = message
      try {
        child.kill('SIGKILL')
      } catch {
        finish({ ok: false, error: message })
      }
    }
    const makeAppendOutput = (sink: (text: string) => void) => {
      return (chunk: Buffer) => {
        if (forcedError) return
        outputBytes += chunk.byteLength
        if (outputBytes > maxOutputBytes) {
          stop('Blender output exceeded the 8MB safety limit.')
          return
        }
        sink(chunk.toString('utf8'))
      }
    }
    child.stdout?.on(
      'data',
      makeAppendOutput((text) => (stdout += text)),
    )
    child.stderr?.on(
      'data',
      makeAppendOutput((text) => (stderr += text)),
    )
    child.on('error', (error) => finish({ ok: false, error: error.message }))
    child.on('close', (code) => {
      if (forcedError) {
        finish({ ok: false, error: forcedError })
        return
      }
      // Error diagnostics combine both streams (Python tracebacks and
      // Blender's "Error: Python:" lines land on stderr); only the JSON
      // marker parse done by callers is stdout-only.
      const combined = stdout + stderr
      if (code !== 0) {
        const detail = combined.trim().slice(-4_000)
        finish({
          ok: false,
          error: `Blender exited with status ${code}${detail ? `: ${detail}` : ''}`,
        })
        return
      }
      if (
        combined.includes('Traceback (most recent call last)') ||
        combined.includes('Error: Python:')
      ) {
        finish({
          ok: false,
          error: `Blender Python execution failed: ${combined.trim().slice(-4_000)}`,
        })
        return
      }
      // A clean exit is part of the RESULT, not something each caller has to
      // re-derive: the failure branches above already cover a non-zero exit or a
      // spawn error, so a success shape reports `exitCode: 0` explicitly and the
      // edit path can require it before it treats the working copy as trustworthy.
      finish({ ok: true, stdout, exitCode: 0 })
    })
    const timeoutId = setTimeout(
      () => stop(`Blender operation timed out after ${timeout}ms.`),
      timeout,
    )
    const onAbort = () => stop('Blender operation cancelled.')
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function summarizeGltf(document: JsonRecord): JsonRecord {
  const array = (key: string) =>
    Array.isArray(document[key]) ? (document[key] as JsonRecord[]) : []
  const named = (key: string) =>
    array(key)
      .slice(0, 1_000)
      .map((entry, index) => String(entry.name ?? `${key}-${index}`))
  return {
    asset: document.asset ?? null,
    sceneCount: array('scenes').length,
    activeScene: document.scene ?? null,
    nodes: array('nodes')
      .slice(0, 1_000)
      .map((node, index) => ({
        name: String(node.name ?? `node-${index}`),
        mesh: node.mesh ?? null,
        camera: node.camera ?? null,
        children: node.children ?? [],
        translation: node.translation ?? [0, 0, 0],
        rotation: node.rotation ?? [0, 0, 0, 1],
        scale: node.scale ?? [1, 1, 1],
      })),
    meshes: array('meshes')
      .slice(0, 1_000)
      .map((mesh, index) => ({
        name: String(mesh.name ?? `mesh-${index}`),
        primitiveCount: Array.isArray(mesh.primitives)
          ? mesh.primitives.length
          : 0,
      })),
    materials: named('materials'),
    textures: named('textures'),
    images: array('images')
      .slice(0, 1_000)
      .map((image, index) => ({
        name: String(image.name ?? `image-${index}`),
        uri: image.uri ?? null,
        mimeType: image.mimeType ?? null,
      })),
    cameras: named('cameras'),
    animations: named('animations'),
    skins: named('skins'),
  }
}

function collectGltfUris(document: JsonRecord): string[] {
  const uris = new Set<string>()
  for (const key of ['buffers', 'images']) {
    const entries = Array.isArray(document[key])
      ? (document[key] as JsonRecord[])
      : []
    for (const entry of entries) {
      if (
        typeof entry.uri === 'string' &&
        !entry.uri.startsWith('data:') &&
        !entry.uri.includes('://')
      ) {
        uris.add(entry.uri)
      }
    }
  }
  return [...uris]
}

async function findMissingGltfDependencies(params: {
  document: JsonRecord
  sourcePath: string
  cwd: string
  fs: CodebuffFileSystem
  fileFilter?: FileFilter
}): Promise<{ dependencies: string[]; missingDependencies: string[] }> {
  const dependencies = collectGltfUris(params.document)
  const missingDependencies: string[] = []
  const sourceDirectory = path.posix.dirname(params.sourcePath)
  for (const uri of dependencies) {
    let decoded: string
    try {
      decoded = decodeURIComponent(uri)
    } catch {
      missingDependencies.push(uri)
      continue
    }
    const candidate = path.posix.normalize(
      path.posix.join(sourceDirectory, decoded),
    )
    if (isReadPathBlocked(candidate, params.fileFilter)) {
      missingDependencies.push(uri)
      continue
    }
    const resolved = await resolveFilePathForFileSystemOperation(
      params.cwd,
      candidate,
      params.fs,
    )
    if (!resolved) {
      missingDependencies.push(uri)
      continue
    }
    try {
      const stats = await params.fs.stat(resolved.operationPath)
      if (!stats.isFile()) missingDependencies.push(uri)
    } catch {
      missingDependencies.push(uri)
    }
  }
  return { dependencies, missingDependencies }
}

function parseGlb(buffer: Buffer): JsonRecord {
  if (buffer.length < 20 || buffer.toString('ascii', 0, 4) !== 'glTF') {
    throw new Error('Invalid GLB header.')
  }
  const version = buffer.readUInt32LE(4)
  const declaredLength = buffer.readUInt32LE(8)
  if (version !== 2 || declaredLength > buffer.length) {
    throw new Error(`Unsupported or truncated GLB (version ${version}).`)
  }
  const chunkLength = buffer.readUInt32LE(12)
  const chunkType = buffer.readUInt32LE(16)
  if (chunkType !== 0x4e4f534a || 20 + chunkLength > buffer.length) {
    throw new Error('GLB does not begin with a valid JSON chunk.')
  }
  return JSON.parse(buffer.toString('utf8', 20, 20 + chunkLength).trim())
}

function summarizeObj(content: string): JsonRecord {
  const counts = { vertices: 0, textureCoordinates: 0, normals: 0, faces: 0 }
  const objects = new Set<string>()
  const groups = new Set<string>()
  const materials = new Set<string>()
  const materialLibraries = new Set<string>()
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.startsWith('v ')) counts.vertices++
    else if (line.startsWith('vt ')) counts.textureCoordinates++
    else if (line.startsWith('vn ')) counts.normals++
    else if (line.startsWith('f ')) counts.faces++
    else if (line.startsWith('o ')) objects.add(line.slice(2).trim())
    else if (line.startsWith('g ')) groups.add(line.slice(2).trim())
    else if (line.startsWith('usemtl ')) materials.add(line.slice(7).trim())
    else if (line.startsWith('mtllib '))
      materialLibraries.add(line.slice(7).trim())
  }
  return {
    ...counts,
    objects: [...objects].slice(0, 500),
    groups: [...groups].slice(0, 500),
    materials: [...materials].slice(0, 500),
    materialLibraries: [...materialLibraries].slice(0, 100),
  }
}

async function readContainedAsset(params: {
  assetPath: string
  cwd: string
  fs: CodebuffFileSystem
  fileFilter?: FileFilter
}) {
  const resolved = await resolveFilePathForFileSystemOperation(
    params.cwd,
    params.assetPath,
    params.fs,
  )
  if (!resolved) throw new Error('Asset path is outside the project root.')
  if (isReadPathBlocked(resolved.relativePath, params.fileFilter)) {
    throw new Error(
      'Asset path is blocked by the authorized filesystem policy.',
    )
  }
  const format = get3dAssetFormat(resolved.relativePath)
  if (!format) throw new Error('Unsupported 3D asset format.')
  const stats = await params.fs.stat(resolved.operationPath)
  if (!stats.isFile()) throw new Error('Asset path is not a file.')
  if (stats.size > MAX_INSPECT_BYTES) {
    throw new Error(
      `Asset exceeds the ${MAX_INSPECT_BYTES} byte inspection limit.`,
    )
  }
  const data = Buffer.from(await params.fs.readFile(resolved.operationPath))
  return { resolved, format, stats, data, sourceHash: sha256(data) }
}

export async function inspect3dAsset(params: {
  path: string
  cwd: string
  fs: CodebuffFileSystem
  signal?: AbortSignal
  execution?: ExecutionAdapterContext
  fileFilter?: FileFilter
  logger?: Logger
}): Promise<CodebuffToolOutput<'inspect_3d_asset'>> {
  try {
    if (params.signal?.aborted) throw new Error('3D inspection cancelled.')
    const execution = blenderExecution(params.execution, BLENDER_TIMEOUT_MS)
    const asset = await readContainedAsset({
      assetPath: params.path,
      cwd: params.cwd,
      fs: params.fs,
      fileFilter: params.fileFilter,
    })
    let summary: JsonRecord
    if (asset.format === 'gltf') {
      if (asset.data.length > MAX_TEXT_ASSET_BYTES) {
        throw new Error('glTF JSON exceeds the structured parser size limit.')
      }
      const document = JSON.parse(asset.data.toString('utf8')) as JsonRecord
      summary = {
        ...summarizeGltf(document),
        ...(await findMissingGltfDependencies({
          document,
          sourcePath: asset.resolved.relativePath,
          cwd: params.cwd,
          fs: params.fs,
          fileFilter: params.fileFilter,
        })),
      }
    } else if (asset.format === 'glb') {
      const document = parseGlb(asset.data)
      summary = {
        ...summarizeGltf(document),
        ...(await findMissingGltfDependencies({
          document,
          sourcePath: asset.resolved.relativePath,
          cwd: params.cwd,
          fs: params.fs,
          fileFilter: params.fileFilter,
        })),
      }
    } else if (asset.format === 'obj') {
      if (asset.data.length > MAX_TEXT_ASSET_BYTES) {
        throw new Error('OBJ exceeds the structured parser size limit.')
      }
      summary = summarizeObj(asset.data.toString('utf8'))
    } else if (asset.format === 'blend') {
      const blender = await runBlender(
        [
          '--background',
          asset.resolved.operationPath,
          '--python-expr',
          BLENDER_INSPECT_SCRIPT,
        ],
        BLENDER_TIMEOUT_MS,
        {},
        params.signal,
        execution,
        'blender.inspect-blend',
        params.cwd,
      )
      if (!blender.ok) throw blender.executionRefusal ? new ExecutionRefusalError(blender.executionRefusal) : new Error(blender.error)
      const markerIndex = blender.stdout.lastIndexOf(BLENDER_JSON_MARKER)
      if (markerIndex < 0)
        throw new Error('Blender did not return a scene summary.')
      const line = blender.stdout
        .slice(markerIndex + BLENDER_JSON_MARKER.length)
        .split(/\r?\n/, 1)[0]
      summary = JSON.parse(line)
    } else {
      const blender = await runBlender(
        ['--background', '--python-expr', BLENDER_IMPORT_AND_INSPECT_SCRIPT],
        BLENDER_TIMEOUT_MS,
        {
          OPENBUFF_3D_SOURCE_PATH: asset.resolved.operationPath,
          OPENBUFF_3D_SOURCE_FORMAT: asset.format,
        },
        params.signal,
        execution,
        'blender.inspect-import',
        params.cwd,
      )
      if (!blender.ok) throw blender.executionRefusal ? new ExecutionRefusalError(blender.executionRefusal) : new Error(blender.error)
      const markerIndex = blender.stdout.lastIndexOf(BLENDER_JSON_MARKER)
      if (markerIndex < 0)
        throw new Error('Blender did not return a scene summary.')
      summary = JSON.parse(
        blender.stdout
          .slice(markerIndex + BLENDER_JSON_MARKER.length)
          .split(/\r?\n/, 1)[0],
      )
    }
    const derivedMetadata = {
      version: 1,
      sourcePath: asset.resolved.relativePath,
      sourceHash: asset.sourceHash,
      format: asset.format,
      concepts: collectSceneConcepts(summary),
      summary,
    }
    const relativeMetadataPath = path.posix.join(
      '.openbuff',
      'artifacts',
      '3d',
      'metadata',
      `${asset.sourceHash}.json`,
    )
    let derivedMetadataPath: string | undefined
    try {
      const absoluteMetadataPath = path.join(
        params.cwd,
        ...relativeMetadataPath.split('/'),
      )
      await params.fs.mkdir(path.dirname(absoluteMetadataPath), {
        recursive: true,
      })
      const metadataContent = `${JSON.stringify(derivedMetadata)}\n`
      if (params.fs.createFileExclusive) {
        try {
          await params.fs.createFileExclusive(
            absoluteMetadataPath,
            metadataContent,
          )
        } catch (error) {
          if (
            !error ||
            typeof error !== 'object' ||
            !('code' in error) ||
            error.code !== 'EEXIST'
          ) {
            throw error
          }
        }
      } else {
        await params.fs.writeFile(absoluteMetadataPath, metadataContent)
      }
      derivedMetadataPath = relativeMetadataPath
    } catch (error) {
      // Inspection remains useful even when an adapter cannot persist caches;
      // surface the failure once (warn) instead of silently swallowing it.
      params.logger?.warn?.(
        {
          path: params.path,
          error:
            error instanceof Error
              ? error.message
              : String(error).slice(0, 300),
        },
        'openbuff 3d: failed to persist the derived metadata cache',
      )
    }
    return jsonOutput<'inspect_3d_asset'>({
      path: asset.resolved.relativePath,
      format: asset.format,
      sizeBytes: asset.stats.size,
      sourceHash: asset.sourceHash,
      ...(derivedMetadataPath ? { derivedMetadataPath } : {}),
      summary,
    })
  } catch (error) {
    return jsonOutput<'inspect_3d_asset'>({
      path: params.path,
      error: error instanceof Error ? error.message : String(error),
      ...(isExecutionRefusalError(error) ? { executionRefusal: error.refusal } : {}),
    })
  }
}

export async function render3dPreview(params: {
  path: string
  views: Array<'camera' | 'perspective' | 'front' | 'side' | 'top'>
  mode: 'material' | 'clay' | 'wireframe'
  width: number
  height: number
  cwd: string
  fs: CodebuffFileSystem
  signal?: AbortSignal
  execution?: ExecutionAdapterContext
  fileFilter?: FileFilter
}): Promise<CodebuffToolOutput<'render_3d_preview'>> {
  try {
    if (params.signal?.aborted) throw new Error('Blender operation cancelled.')
    const execution = blenderExecution(
      params.execution,
      Math.max(BLENDER_TIMEOUT_MS, params.views.length * 90_000),
    )
    const asset = await readContainedAsset({
      assetPath: params.path,
      cwd: params.cwd,
      fs: params.fs,
      fileFilter: params.fileFilter,
    })
    const runId = `${asset.sourceHash.slice(0, 12)}-${randomUUID().slice(0, 8)}`
    const relativeOutputDir = path.posix.join(
      '.openbuff',
      'artifacts',
      '3d',
      runId,
    )
    const outputDir = path.join(params.cwd, ...relativeOutputDir.split('/'))
    await params.fs.mkdir(outputDir, { recursive: true })
    const previewScriptPath = path.join(outputDir, 'render-preview.py')
    await params.fs.writeFile(
      previewScriptPath,
      asset.format === 'blend'
        ? BLENDER_PREVIEW_SCRIPT
        : BLENDER_IMPORT_SCRIPT + BLENDER_PREVIEW_SCRIPT,
      { flag: 'wx' },
    )
    const blender = await runBlender(
      asset.format === 'blend'
        ? [
            '--background',
            asset.resolved.operationPath,
            '--python',
            previewScriptPath,
          ]
        : ['--background', '--python', previewScriptPath],
      Math.max(BLENDER_TIMEOUT_MS, params.views.length * 90_000),
      {
        OPENBUFF_3D_OUTPUT_DIR: outputDir,
        OPENBUFF_3D_VIEWS: params.views.join(','),
        OPENBUFF_3D_MODE: params.mode,
        OPENBUFF_3D_WIDTH: String(params.width),
        OPENBUFF_3D_HEIGHT: String(params.height),
        OPENBUFF_3D_SOURCE_PATH: asset.resolved.operationPath,
        OPENBUFF_3D_SOURCE_FORMAT: asset.format,
      },
      params.signal,
      execution,
      'blender.preview',
      params.cwd,
    )
    if (!blender.ok) throw blender.executionRefusal ? new ExecutionRefusalError(blender.executionRefusal) : new Error(blender.error)

    const createdAt = new Date().toISOString()
    const receipts: AssetReceipt[] = []
    const imagePaths: string[] = []
    for (const view of params.views) {
      const relativePath = path.posix.join(
        relativeOutputDir,
        `${view}-${params.mode}.png`,
      )
      const absolutePath = path.join(params.cwd, ...relativePath.split('/'))
      let image: Buffer
      try {
        image = Buffer.from(await params.fs.readFile(absolutePath))
      } catch {
        throw new Error(
          `Blender completed without producing ${relativePath}. Output: ${blender.stdout.slice(-2_000)}`,
        )
      }
      imagePaths.push(relativePath)
      receipts.push({
        path: relativePath,
        sourcePath: asset.resolved.relativePath,
        sourceHash: asset.sourceHash,
        artifactHash: sha256(image),
        mediaType: 'image/png',
        dimensions: { width: params.width, height: params.height },
        producer: 'blender',
        createdAt,
        view,
        mode: params.mode,
      })
    }
    const media = await readImages({
      paths: imagePaths,
      cwd: params.cwd,
      fs: params.fs,
      fileFilter: params.fileFilter,
    })
    return [
      {
        type: 'json',
        value: { sourcePath: asset.resolved.relativePath, receipts },
      },
      ...media.filter((part) => part.type === 'media'),
    ]
  } catch (error) {
    return jsonOutput<'render_3d_preview'>({
      path: params.path,
      error: error instanceof Error ? error.message : String(error),
      ...(isExecutionRefusalError(error) ? { executionRefusal: error.refusal } : {}),
    })
  }
}

export async function edit3dAsset(params: {
  path: string
  sourceHash: string
  operations: JsonRecord[]
  cwd: string
  fs: CodebuffFileSystem
  operationId?: string
  signal?: AbortSignal
  execution?: ExecutionAdapterContext
  fileFilter?: FileFilter
}): Promise<CodebuffToolOutput<'edit_3d_asset'>> {
  const operationId =
    params.operationId && /^[a-zA-Z0-9._-]{1,128}$/.test(params.operationId)
      ? params.operationId
      : randomUUID()
  const actionId = `${operationId}:0`
  /*
   * RELEASE TARGET: ONE stable directory per operation, not one per attempt.
   *
   * The attempt's artifacts are FILES inside it, named with an attempt uuid
   * prefix (`<attemptId>.blend`, `<attemptId>.py`, `<attemptId>.json`). That
   * split is what makes a terminal release possible at all: the contracted
   * adapter surface (`CodebuffFileSystemBase`) has `unlink` but no `rmdir`/`rm`,
   * so a per-attempt DIRECTORY could be emptied and never removed — every
   * rejected, cancelled, timed-out or threw attempt would leave one empty leaf
   * directory in the user's project forever, and the release could never
   * honestly report success. Emptied FILES are confirmable, so the baseline
   * "directories remaining after N non-applied attempts" is a real 0: a
   * non-applied attempt creates no directory at all.
   *
   * Why the filenames stay attempt-scoped: `operationId` is REUSABLE (it is
   * caller-supplied whenever it matches the pattern above, and a retrying
   * caller reuses exactly that correlated id). A retry that did not end in
   * `applied` must not delete a previous attempt's `*.blend` — the file the
   * previous receipt's `artifactPath` promises is readable — while that
   * mutation is durable. Prefix-scoped release makes that impossible by
   * construction: this call only ever unlinks its own files, which it wrote
   * with `{ flag: 'wx' }` into paths no earlier attempt has ever used.
   */
  const attemptId = randomUUID()
  const attemptArtifactPrefix = `${attemptId}.`
  /*
   * Set the instant the guarded commit WINS (or its outcome becomes UNKNOWN).
   * From then on this attempt's files are no longer expendable scratch: the
   * `applied` path's receipt names one as `artifactPath`, and an unknown commit
   * outcome must keep the working copy for reconciliation, so no later exit may
   * release them (see `releaseArtifactDir`).
   */
  let committed = false
  let retainAttemptArtifacts = false
  let ownedArtifactDir: string | undefined
  /*
   * Read one attempt's file names out of the release target. `null` means the
   * listing could not be OBSERVED (the call rejected, or an adapter answered
   * with something that is not an entry list), which is deliberately distinct
   * from "the directory holds none of my files": an unobservable listing can
   * never confirm a release.
   */
  const listArtifactDir = async (dir: string): Promise<string[] | null> => {
    try {
      const entries: unknown = await params.fs.readdir(dir)
      return Array.isArray(entries)
        ? entries.map((entry) => String(entry))
        : null
    } catch {
      return null
    }
  }
  /*
   * A release is never assumed: success means NO file of THIS attempt remains
   * observable in the release target. Only then is ownership surrendered, so a
   * partial removal stays releasable by the next `releaseArtifactDir()` call
   * instead of leaving a full asset copy nobody can find again.
   */
  const tryReleaseArtifactDir = async (dir: string): Promise<boolean> => {
    // Only CONTRACTED adapter members are used here: `readdir` and `unlink` are
    // the entirety of `CodebuffFileSystemBase`'s removal surface. `rm`/`rmdir`
    // are NOT part of that published contract, so probing for them structurally
    // would change behaviour per adapter instead of per contract; the layout
    // above is what removes the need for them.
    try {
      // Enumerate instead of unlinking a fixed list of names, filtered to this
      // attempt's prefix: an artifact added to the write path is released here
      // without editing this function, and a sibling attempt's files are never
      // candidates.
      const entries = await listArtifactDir(dir)
      if (entries === null) return false
      for (const entry of entries) {
        if (!entry.startsWith(attemptArtifactPrefix)) continue
        try {
          await params.fs.unlink(path.join(dir, entry))
        } catch {
          // Best-effort per entry; the confirmation below decides the result.
        }
      }
      // Positive confirmation, re-observed AFTER the unlinks: a resolved unlink
      // is never treated as proof that the file is gone.
      const remaining = await listArtifactDir(dir)
      if (remaining === null) return false
      return !remaining.some((entry) => entry.startsWith(attemptArtifactPrefix))
    } catch {
      // Any unexpected throw must not escape into the caller: ownership stays
      // set so a later release retries, and the structured receipt is returned.
      return false
    }
  }
  /**
   * Best-effort removal of the now-EMPTY release target.
   *
   * The contracted adapter surface has `unlink` but no removal capability, so an
   * abandoned attempt could leave `<...>/mutations/<operationId>/current` behind
   * as an empty leaf directory — and a long-lived (correlated, reused)
   * operationId accumulates one such directory per aborted attempt in the user's
   * project. Only adapters that DO offer `rmdir` are pruned, only when the
   * directory is observed empty, and only after the file release was confirmed,
   * so no retained artifact is ever removed.
   */
  const removeEmptyArtifactDir = async (dir: string): Promise<void> => {
    const adapter = params.fs as CodebuffFileSystem & {
      rmdir?: (target: string) => Promise<unknown>
    }
    if (typeof adapter.rmdir !== 'function') return
    try {
      const remaining = await listArtifactDir(dir)
      if (remaining === null || remaining.length > 0) return
      await adapter.rmdir(dir)
    } catch {
      // Best-effort: a directory left behind is never worse than a failed call.
    }
  }
  const releaseArtifactDir = async (): Promise<void> => {
    // Durable provenance, not scratch: see `committed` above. Releasing here
    // would turn a returned receipt's `artifactPath` into a dangling pointer
    // while the source edit stays applied, and an UNKNOWN commit outcome needs
    // the working copy for reconciliation.
    if (committed || retainAttemptArtifacts) return
    const dir = ownedArtifactDir
    if (!dir) return
    // Ownership is only surrendered once removal is CONFIRMED, so a failure
    // keeps the reference and the next release attempt retries it instead of
    // leaking.
    if (await tryReleaseArtifactDir(dir)) {
      ownedArtifactDir = undefined
      await removeEmptyArtifactDir(dir)
    }
  }

  const notApplied = async (
    message: string,
    beforeHash: string | null = null,
    refusal?: Refusal,
  ): Promise<CodebuffToolOutput<'edit_3d_asset'>> => {
    // Cleanup is best-effort and must never replace the receipt: a throw here
    // would turn a structured `not_applied` result into an exception, which is
    // strictly worse for the caller than an unreleased directory.
    await releaseArtifactDir().catch(() => {})
    return [
      {
        type: 'json' as const,
        value: {
          kind: 'file_mutation_result' as const,
          version: 1 as const,
          operationId,
          outcome: 'not_applied' as const,
          ...(refusal ? { executionRefusal: refusal } : {}),
          actions: [
            {
              actionId,
              index: 0,
              action: 'update' as const,
              path: params.path,
              outcome: 'not_applied' as const,
              beforeHash,
              afterHash: null,
              error: {
                code: 'application_rejected' as const,
                message,
                retryable: false,
              },
            },
          ],
          authorityTier: null,
          errors: [
            {
              code: 'application_rejected' as const,
              message,
              retryable: false,
            },
          ],
          freshCapabilities: [],
        },
      },
    ]
  }

  try {
    if (params.signal?.aborted) {
      return await notApplied('Blender operation cancelled.')
    }
    const execution = blenderExecution(params.execution, BLENDER_TIMEOUT_MS)
    if (!params.fs.conditionalCommit) {
      return await notApplied(
        'Guarded 3D edits require a filesystem adapter with conditionalCommit authority.',
      )
    }
    const asset = await readContainedAsset({
      assetPath: params.path,
      cwd: params.cwd,
      fs: params.fs,
      fileFilter: params.fileFilter,
    })
    if (asset.format !== 'blend') {
      return await notApplied(
        'Declarative 3D edits currently require a .blend file.',
      )
    }
    const requestedHash = params.sourceHash.replace(/^sha256:/, '')
    if (requestedHash !== asset.sourceHash) {
      return await notApplied(
        'The source hash is stale. Inspect the asset again before editing.',
        `sha256:${asset.sourceHash}`,
      )
    }

    const relativeArtifactDir = path.posix.join(
      '.openbuff',
      'artifacts',
      '3d',
      'mutations',
      operationId,
      'current',
    )
    const artifactDir = path.join(params.cwd, ...relativeArtifactDir.split('/'))
    ownedArtifactDir = artifactDir
    /*
     * OWNERSHIP IS STRUCTURAL from here on, not a convention each exit has to
     * remember: the `finally` below releases this attempt's files on EVERY
     * non-`applied` exit — the structured `not_applied` returns, a throw from
     * any adapter await, a timeout rejection, or an exit shape added later.
     * Release is a no-op once `committed`/`retainAttemptArtifacts` is set.
     */
    try {
      // Attempt-scoped FILENAMES inside one stable release target: a release
      // unlinks exactly this attempt's prefix, so it never touches a sibling
      // attempt's artifact, and it needs no directory removal (which the
      // contracted adapter surface does not offer).
      const workingPath = path.join(
        artifactDir,
        `${attemptId}${ARTIFACT_WORKING_COPY_SUFFIX}`,
      )
      const editScriptPath = path.join(
        artifactDir,
        `${attemptId}${ARTIFACT_EDIT_SCRIPT_SUFFIX}`,
      )
      // CHEAP REJECTION FIRST, before the directory exists: an oversized
      // operations payload must leave ZERO trace, which is only true if the
      // `mkdir` and the attempt's writes below are never reached. (Everything
      // after the mkdir is reclaimed by the release path; nothing before it
      // needs reclaiming at all.)
      const operationsJson = JSON.stringify(params.operations)
      if (operationsJson.length > MAX_OPERATIONS_FILE_CHARS) {
        return await notApplied(
          `The operations payload is too large (${operationsJson.length} chars; the limit is ${MAX_OPERATIONS_FILE_CHARS}). Split the edit into smaller batches.`,
        )
      }
      await params.fs.mkdir(artifactDir, { recursive: true })
      await params.fs.writeFile(workingPath, asset.data, { flag: 'wx' })
      await params.fs.writeFile(editScriptPath, BLENDER_EDIT_SCRIPT, {
        flag: 'wx',
      })

      // The payload travels as a FILE, not as an env value: `{ flag: 'wx' }`
      // matches the sibling working-copy/edit-script writes. The name carries
      // this attempt's uuid, so `wx` can only ever collide with this call's own
      // earlier write — never with a previous attempt's artifacts.
      const operationsPath = path.join(
        artifactDir,
        `${attemptId}${ARTIFACT_OPERATIONS_SUFFIX}`,
      )
      await params.fs.writeFile(operationsPath, operationsJson, { flag: 'wx' })

      const blender = await runBlender(
        ['--background', workingPath, '--python', editScriptPath],
        BLENDER_TIMEOUT_MS,
        {
          // Only a short path crosses as an env value now, so it is safe on
          // every platform regardless of payload size.
          OPENBUFF_3D_OPERATIONS_PATH: operationsPath,
        },
        params.signal,
        execution,
        'blender.edit',
        params.cwd,
      )
      // A clean exit is REQUIRED, not implied by "the process started and
      // returned": a Blender that crashed after writing a partial or complete
      // working copy must not let this attempt proceed to validation and commit
      // with a file whose provenance is unverified. A non-clean exit routes
      // through `notApplied`, so the structural release in the `finally` still
      // reclaims this attempt's files.
      if (!blender.ok || blender.exitCode !== 0) {
        return await notApplied(
          blender.ok
            ? "Blender exited without a clean status, so this attempt's working copy is not trusted."
            : blender.error,
          `sha256:${asset.sourceHash}`,
          blender.ok ? undefined : blender.executionRefusal,
        )
      }
      const markerIndex = blender.stdout.lastIndexOf(BLENDER_JSON_MARKER)
      if (markerIndex < 0) {
        return await notApplied(
          'Blender saved no structured mutation receipt.',
          `sha256:${asset.sourceHash}`,
        )
      }
      const mutationReceipt = JSON.parse(
        blender.stdout
          .slice(markerIndex + BLENDER_JSON_MARKER.length)
          .split(/\r?\n/, 1)[0],
      ) as JsonRecord
      const changedOperations = Array.isArray(mutationReceipt.changed)
        ? mutationReceipt.changed
        : []
      const validation = await runBlender(
        ['--background', workingPath, '--python-expr', BLENDER_INSPECT_SCRIPT],
        BLENDER_TIMEOUT_MS,
        {},
        params.signal,
        execution,
        'blender.validate',
        params.cwd,
      )
      if (!validation.ok || !validation.stdout.includes(BLENDER_JSON_MARKER)) {
        return await notApplied(
          validation.ok
            ? 'The edited Blender file failed structured validation.'
            : validation.error,
          `sha256:${asset.sourceHash}`,
          validation.ok ? undefined : validation.executionRefusal,
        )
      }
      if (params.signal?.aborted) {
        return await notApplied(
          'Blender operation cancelled before commit.',
          `sha256:${asset.sourceHash}`,
        )
      }
      const editedData = Buffer.from(await params.fs.readFile(workingPath))
      const editedHash = sha256(editedData)
      let commitResult: Awaited<
        ReturnType<NonNullable<CodebuffFileSystem['conditionalCommit']>>
      >
      try {
        commitResult = await params.fs.conditionalCommit(
          asset.resolved.operationPath,
          editedData,
          { expectedHash: `sha256:${asset.sourceHash}` },
        )
      } catch (error) {
        /*
         * COMMIT OUTCOME UNKNOWN. The guarded write REJECTED (abort, adapter
         * error, process shutdown), so the edit may or may not have landed.
         * Neither "reverted" nor "applied" is asserted: the attempt's files
         * are RETAINED and named in the receipt so the operator can reconcile,
         * instead of the ambiguity being reported as a clean `not_applied`
         * while the only copy of the attempted result is deleted.
         */
        retainAttemptArtifacts = true
        const unknownMessage = `The guarded commit failed while it was being applied (${
          error instanceof Error ? error.message : String(error)
        }), so the OUTCOME IS UNKNOWN: the source edit may or may not have been written. The attempted result was retained at ${relativeArtifactDir} (working copy ${attemptId}${ARTIFACT_WORKING_COPY_SUFFIX}); compare it against ${asset.resolved.relativePath} before retrying.`
        return [
          {
            type: 'json' as const,
            value: {
              kind: 'file_mutation_result' as const,
              version: 1 as const,
              operationId,
              outcome: 'commit_outcome_unknown' as const,
              actions: [
                {
                  actionId,
                  index: 0,
                  action: 'update' as const,
                  path: params.path,
                  outcome: 'commit_outcome_unknown' as const,
                  beforeHash: `sha256:${asset.sourceHash}`,
                  afterHash: null,
                  error: {
                    code: 'application_unconfirmed' as const,
                    message: unknownMessage,
                    retryable: false,
                  },
                },
              ],
              authorityTier: null,
              errors: [
                {
                  code: 'application_unconfirmed' as const,
                  message: unknownMessage,
                  retryable: false,
                },
              ],
              freshCapabilities: [],
            },
          },
        ]
      }
      if (!commitResult.applied) {
        return await notApplied(
          'The source changed before the guarded commit. No source file was overwritten.',
          commitResult.actualHash,
        )
      }
      /*
       * The commit has WON. The source file is edited from here, so the receipt
       * and the artifact its `artifactPath` names must both survive: every exit
       * below is either the `applied` return or a not-applied exit that still
       * must NOT release these files.
       */
      committed = true

      const preview = await render3dPreview({
        path: asset.resolved.relativePath,
        views: ['perspective'],
        mode: 'clay',
        width: 512,
        height: 512,
        cwd: params.cwd,
        fs: params.fs,
        signal: params.signal,
        execution,
        fileFilter: params.fileFilter,
      })
      const previewJsonPart = preview.find((part) => part.type === 'json')
      const previewBody =
        previewJsonPart?.type === 'json' ? previewJsonPart.value : undefined
      // The committed edit and its `artifactPath` are retained from here on, so
      // the receipt must always SELF-DESCRIBE the preview: when
      // `render3dPreview` fails or is cancelled it returns an `{ error }` json
      // part and no media, and publishing `preview: null` there would leave a
      // retained full-asset artifact with nothing explaining why no preview
      // came back. The error text is surfaced verbatim instead.
      const previewSummary = previewBody ?? {
        error:
          'The post-commit preview could not be rendered (the edit was cancelled or Blender failed after the commit won). The applied edit and artifactPath below remain valid.',
      }
      // The receipt below names `<attemptId>.blend`, so that path is protected
      // from reclamation BEFORE the prune can consider it — including on the
      // over-count branch, which no longer relies on the current attempt being
      // the newest one.
      // Bounded reclamation of OLDER retained copies. Runs only after the
      // commit won, so a non-applied attempt never pays for it, and it never
      // touches the copy this receipt names (the prune skips `attemptId`).
      await prune3dMutationArtifacts({
        fs: params.fs,
        currentOperationDir: artifactDir,
        attemptId,
      })

      return [
        {
          type: 'json',
          value: {
            kind: 'file_mutation_result',
            version: 1,
            operationId,
            outcome: 'applied',
            actions: [
              {
                actionId,
                index: 0,
                action: 'update',
                path: asset.resolved.relativePath,
                outcome: 'applied',
                beforeHash: `sha256:${asset.sourceHash}`,
                afterHash: `sha256:${editedHash}`,
              },
            ],
            authorityTier: 'conditional_commit',
            errors: [],
            freshCapabilities: [],
          },
        },
        {
          type: 'json',
          value: {
            assetMutation: {
              sourcePath: asset.resolved.relativePath,
              sourceHash: asset.sourceHash,
              resultHash: editedHash,
              artifactPath: path.posix.join(
                relativeArtifactDir,
                `${attemptId}${ARTIFACT_WORKING_COPY_SUFFIX}`,
              ),
              producer: 'blender',
              createdAt: new Date().toISOString(),
              operations: changedOperations,
              validation: 'reopened_and_inspected',
              preview: previewSummary,
              previewRendered: previewJsonPart !== undefined,
            },
          },
        },
        ...preview.filter((part) => part.type === 'media'),
      ]
    } finally {
      // Structural release: every non-`applied` exit above — structured
      // `not_applied`, a throw from any adapter await, a commit rejection, or
      // an exit shape added later — passes through here. A no-op once the
      // commit won or its outcome became unknown.
      await releaseArtifactDir().catch(() => {})
    }
  } catch (error) {
    return await notApplied(
      error instanceof Error ? error.message : String(error),
      null,
      isExecutionRefusalError(error) ? error.refusal : undefined,
    )
  }
}
