import {
  captureNativeMountPolicy,
  dispatchNativeLaunch,
  nativeAdapterOptions,
  nativeExpiryNs,
} from './native-exec'
import fs from 'node:fs'
import path from 'node:path'

import type {
  ActionExecutionPort,
  Capability,
  Clock,
  PreparedLaunch,
  ProfileFacts,
  ProfileRequest,
  Result,
  TargetDescription,
} from '@codebuff/common/types/contracts/execution-context'
import type { CodebuffSpawn as Spawn } from '@codebuff/common/types/spawn'
import type {
  NativeClockMapping,
  NativeDispatchOptions,
  VerifiedNativeInstallation,
} from './native-exec'
import type {
  AdmittedNodeLaunch,
  NodeDispatchResult,
  NodeTerminationOptions,
} from './execution-launch'

/** Host-owned verified installation and calibration; never read from a target. */
export type NativeHostExecution = Readonly<{
  installation: VerifiedNativeInstallation
  mapping: NativeClockMapping
  clock: Clock
  runtimePaths: readonly string[]
  network?: 'deny' | 'inherit'
  landlock?: 'disabled' | 'optional' | 'required'
}>

type Registry = ReturnType<typeof createNativeHostRegistry>
const ports = new WeakMap<ActionExecutionPort, Registry>()
const launches = new WeakMap<PreparedLaunch, NativeDispatchOptions>()
const refusal = (cause: string): Result<never> => ({
  ok: false,
  reason: 'unavailable',
  cause,
})

export function createNativeHostRegistry(
  native: NativeHostExecution | undefined,
  clock: Clock,
  spawn?: Spawn,
  environment: Readonly<Record<string, string | undefined>> = {},
) {
  const selected =
    native &&
    Object.freeze({
      ...native,
      runtimePaths: Object.freeze([...native.runtimePaths]),
    })
  const selections = new Map<
    string,
    Readonly<{
      pins: Readonly<Record<string, string>>
      options: NativeDispatchOptions
    }>
  >()
  const selectionKey = (pins: TargetDescription['adapterOptions']) =>
    JSON.stringify([
      pins.nativeMountDigest,
      pins.nativeNetwork,
      pins.nativeLandlock,
      pins.nativeMaxRetainedOutputBytes,
    ])
  const supported = (target: TargetDescription) =>
    target.adapterOptions.runtime === 'node' &&
    [
      'sync-shell',
      'background-job',
      'diagnostic-build-version-scip',
      'native-role',
    ].includes(target.family)
  function find(target: TargetDescription) {
    if (!supported(target)) return undefined
    const value = selections.get(selectionKey(target.adapterOptions))
    return value &&
      Object.entries(value.pins).every(
        ([key, pin]) => target.adapterOptions[key] === pin,
      )
      ? value
      : undefined
  }
  function capture(target: TargetDescription): Result<TargetDescription> {
    if (target.profile.preferredBackend !== 'native-exec')
      return { ok: true, value: target }
    if (!supported(target))
      return target.profile.allowBackendFallback
        ? { ok: true, value: target }
        : refusal(
            'Native one-shot dispatch is unavailable for this target family/runtime',
          )
    if (!selected || selected.clock !== clock)
      return target.profile.allowBackendFallback
        ? { ok: true, value: target }
        : refusal(
            'Verified native installation/calibration is unavailable for this host clock',
          )
    const mapping = nativeExpiryNs(
      selected.mapping,
      selected.installation,
      clock,
      clock.nowMs() + 1000,
    )
    if (!mapping.ok)
      return target.profile.allowBackendFallback
        ? { ok: true, value: target }
        : mapping
    const mounts = captureNativeMountPolicy({
      projectRoot: target.projectRoot,
      allowedPaths: target.allowedPaths,
      policy: target.profile.policy,
      runtimePaths: selected.runtimePaths,
    })
    if (!mounts.ok)
      return target.profile.allowBackendFallback
        ? { ok: true, value: target }
        : mounts
    const network =
      target.profile.policy === 'full-access'
        ? 'inherit'
        : (selected.network ?? 'deny')
    const landlock =
      target.profile.policy === 'full-access'
        ? 'disabled'
        : (selected.landlock ?? 'optional')
    const pins = nativeAdapterOptions(selected.installation, mounts.value, {
      network,
      landlock,
      ...(typeof target.adapterOptions.maxRetainedOutputBytes === 'number'
        ? {
            maxRetainedOutputBytes:
              target.adapterOptions.maxRetainedOutputBytes,
          }
        : {}),
    })
    if (!pins.ok)
      return target.profile.allowBackendFallback
        ? { ok: true, value: target }
        : pins
    const options = Object.freeze({
      installation: selected.installation,
      mapping: selected.mapping,
      clock,
      mounts: mounts.value,
      network,
      landlock,
      ...(spawn ? { spawn } : {}),
    })
    // Policy is part of mount identity; network/layer choices are immutable per host.
    selections.set(
      selectionKey(pins.value),
      Object.freeze({ pins: pins.value, options }),
    )
    let executable = target.executable
    if (!path.isAbsolute(executable)) {
      const overlay = target.environmentOverlay
      const lookupPath =
        overlay && Object.hasOwn(overlay, 'PATH')
          ? overlay.PATH
          : environment.PATH
      const candidates = executable.includes('/')
        ? [path.resolve(target.cwd, executable)]
        : (lookupPath ?? '')
            .split(':')
            .filter(Boolean)
            .map((directory) => path.resolve(target.cwd, directory, executable))
      const resolved = candidates.find((candidate) => {
        try {
          fs.accessSync(candidate, fs.constants.X_OK)
          return fs.statSync(candidate).isFile()
        } catch {
          return false
        }
      })
      if (!resolved)
        return refusal(
          'Native executable is unavailable on the captured child PATH',
        )
      executable = fs.realpathSync(resolved)
    }
    return {
      ok: true,
      value: Object.freeze({
        ...target,
        executable,
        adapterOptions: Object.freeze({
          ...target.adapterOptions,
          ...pins.value,
        }),
      }),
    }
  }
  function resolve(
    request: ProfileRequest,
    target: TargetDescription,
    portable: ProfileFacts,
  ): ProfileFacts {
    const value = find(target)
    const scoped = request.policy !== 'full-access'
    const capabilities: Capability[] = value
      ? [
          'exact-env',
          'cooperative-cancellation',
          ...(scoped
            ? ([
                'deadline-termination',
                'filesystem-isolation',
                'process-tree-containment',
              ] as const)
            : []),
          ...(scoped && value.options.network === 'deny'
            ? (['network-isolation'] as const)
            : []),
        ]
      : []
    const generation = selected
      ? `native-exec:${selected.installation.artifact.sha256}`
      : 'native-exec:unavailable'
    const available = [
      ...portable.available,
      {
        backend: 'native-exec',
        generation,
        capabilities,
        unavailableReasons: value
          ? [
              'memory-limit is unavailable; enforcement requires native prepared observation',
            ]
          : [
              'No verified native adapter selection is captured for this target',
            ],
      },
    ]
    const canSelect =
      request.preferredBackend === 'native-exec' &&
      value &&
      request.required.every((c) => capabilities.includes(c))
    return {
      requested: request,
      available,
      selected: canSelect
        ? {
            backend: 'native-exec',
            generation,
            policy: request.policy,
            cancellation: scoped ? 'os-scoped' : 'cooperative',
          }
        : portable.selected,
      active: null,
      enforced: canSelect
        ? [...request.required, ...(request.optional ?? [])].map(
            (capability) => ({
              capability,
              status: capabilities.includes(capability)
                ? 'unknown'
                : 'not-enforced',
            }),
          )
        : portable.enforced,
    }
  }
  return Object.freeze({
    capture,
    resolve,
    bind(port: ActionExecutionPort) {
      ports.set(port, this)
    },
    register(
      port: ActionExecutionPort,
      target: TargetDescription,
      launch: PreparedLaunch,
    ) {
      if (ports.get(port) !== this) return
      const value = find(target)
      if (value) launches.set(launch, value.options)
    },
  })
}

export function inheritNativeExecutionPort(
  parent: ActionExecutionPort,
  child: ActionExecutionPort,
): void {
  ports.get(parent)?.bind(child)
}
export function captureRegisteredNativeTarget(
  port: ActionExecutionPort,
  target: TargetDescription,
): Result<TargetDescription> {
  return ports.get(port)?.capture(target) ?? { ok: true, value: target }
}
export function registerPreparedNativeLaunch(
  port: ActionExecutionPort,
  target: TargetDescription,
  launch: PreparedLaunch,
): void {
  ports.get(port)?.register(port, target, launch)
}
export function dispatchRegisteredNativeLaunch(
  admitted: AdmittedNodeLaunch,
  termination: NodeTerminationOptions,
): NodeDispatchResult {
  const options = launches.get(admitted.launch)
  if (!options)
    return refusal('Selected native launch has no host-registered adapter')
  return dispatchNativeLaunch(admitted, {
    ...options,
    ...(termination.output ? { output: termination.output } : {}),
  })
}
