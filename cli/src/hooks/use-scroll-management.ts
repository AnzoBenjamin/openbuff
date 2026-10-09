import { useCallback, useEffect, useRef, useState } from 'react'

import type { ScrollBoxRenderable } from '@opentui/core'

import type { ChatMessage } from '../types/chat'

// Scroll detection threshold - how close to bottom to consider "at bottom"
export const SCROLL_NEAR_BOTTOM_THRESHOLD = 1

/**
 * Canonical at-bottom test shared by every scroll-position reader in this
 * data flow, so transient scrollTop/scrollbar divergence cannot produce
 * disagreeing at-bottom answers in the same pass. Exported for direct unit
 * testing.
 */
export const computeIsNearBottom = (
  current: number,
  maxScroll: number,
): boolean => {
  return Math.abs(maxScroll - current) <= SCROLL_NEAR_BOTTOM_THRESHOLD
}

/**
 * Decide the auto-scroll effect's write for one pass (see the messages effect
 * in useChatScrollbox): the scrollTop to write, or null for no write (clamp
 * above maxScroll, pin to the bottom when following and not collapsing). The
 * position is read through the canonical scrollbar source, since scrollTop
 * transiently diverges after a programmatic write. Exported for direct unit
 * testing.
 */
export const computeAutoScrollTarget = (
  scrollbox: { verticalScrollBar: { scrollPosition: number } },
  maxScroll: number,
  autoScrollEnabled: boolean,
  isUserCollapsing: boolean,
): number | null => {
  const position = scrollbox.verticalScrollBar.scrollPosition
  if (position > maxScroll) return maxScroll
  if (autoScrollEnabled && !isUserCollapsing && position < maxScroll) {
    return maxScroll
  }
  return null
}

/**
 * Whether the auto-scroll effect may skip a non-null computeAutoScrollTarget
 * write (see the messages effect in useChatScrollbox): skip when the current
 * position is already within `epsilon` of the target. computeAutoScrollTarget
 * only returns null on EXACT equality (position === maxScroll), but during
 * streaming the transient maxScroll can sit a fraction of a row above the
 * integer-rounded position, so the effect re-wrote the same visual position
 * on every messages change; when the layout settled at a LOWER maxScroll the
 * clamped-then-re-clamped position snapped the viewport back up. Skipping
 * the within-epsilon write breaks that transient-clamp-then-snap cycle.
 *
 * The clamp path is exempt: a position ABOVE maxScroll is outside the box's
 * valid range, so the clamp is a legitimate safety write that must still
 * fire even within epsilon. Exported for direct unit testing.
 */
export const shouldSkipAutoScrollWrite = (
  position: number,
  target: number,
  maxScroll: number,
  epsilon: number,
): boolean => {
  // The clamp path (a position above maxScroll) is a legitimate safety
  // write: it must fire even when the clamp distance is within epsilon.
  if (position > maxScroll) return false
  return Math.abs(position - target) <= epsilon
}

// Animation constants
const ANIMATION_FRAME_INTERVAL_MS = 16 // ~60fps
const DEFAULT_SCROLL_ANIMATION_DURATION_MS = 200

// Page scroll amount (fraction of viewport height)
const PAGE_SCROLL_FRACTION = 0.8

/**
 * The canonical scroll-position read for the animation entry points:
 * verticalScrollBar.scrollPosition, the same source every other reader in
 * this data flow uses — scrollTop transiently diverges after a programmatic
 * write, so a stale read captures a wrong ease start or page target and
 * snaps the viewport when the canonical position catches up. Exported for
 * direct unit testing.
 */
export const readCanonicalScrollPosition = (scrollbox: {
  verticalScrollBar: { scrollPosition: number }
}): number => {
  return scrollbox.verticalScrollBar.scrollPosition
}

/**
 * Page-scroll destination for one page in `direction`: one page amount from
 * `position`, clamped to [0, maxScroll]. `position` must come from the
 * canonical scroll-position source (readCanonicalScrollPosition). Exported
 * for direct unit testing.
 */
export const computePageScrollTarget = (
  position: number,
  viewportHeight: number,
  maxScroll: number,
  direction: 'up' | 'down',
): number => {
  const scrollAmount = Math.floor(viewportHeight * PAGE_SCROLL_FRACTION)
  if (direction === 'up') return Math.max(0, position - scrollAmount)
  return Math.min(maxScroll, position + scrollAmount)
}

// Delay before auto-scrolling after content changes
const AUTO_SCROLL_DELAY_MS = 50

// Poll interval while waiting for the scrollbox to mount (the scrollRef is
// populated by the rendered scrollbox component, which can happen after this
// hook's first effect run)
const MOUNT_POLL_INTERVAL_MS = 50

// Slower poll interval once a scrollbox is mounted, used only to detect a
// remount (a new ScrollBoxRenderable instance replacing the subscribed one)
const REMOUNT_POLL_INTERVAL_MS = 500

// Deferred re-verification of a compensating anchor write (see adjustScrollTop):
// the child layout producing the new maxScroll can land after the write, so
// the settled position is re-checked and any swallowed residual re-applied,
// bounded in passes and cancelled by any newer scroll intent.
const ANCHOR_VERIFY_DELAY_MS = 32
const ANCHOR_VERIFY_MAX_PASSES = 4
const ANCHOR_VERIFY_EPSILON = 0.5

const easeOutCubic = (t: number): number => {
  return 1 - Math.pow(1 - t, 3)
}

/**
 * Scroll position for one animation frame: eased interpolation from the
 * captured start position toward the CURRENT target, which an anchor
 * compensation may have redirected while the animation was in flight.
 * Exported for direct unit testing.
 */
export const computeAnimationFrameScroll = (
  startScroll: number,
  targetScroll: number,
  easedProgress: number,
): number => {
  return startScroll + (targetScroll - startScroll) * easedProgress
}

/**
 * Clamp a scroll position to the valid range [0, maxScroll]. Applied to the
 * in-flight anchor target fold and to every animation frame write so a
 * mid-flight anchor delta can never park scrollTop outside the box's valid
 * range. Exported for direct unit testing.
 */
export const clampScrollValue = (value: number, maxScroll: number): number => {
  return Math.min(Math.max(0, value), Math.max(0, maxScroll))
}

/**
 * Desired destination for an anchor-verification chain whose goal is the
 * SETTLED bottom rather than a fixed offset (the width-change re-pin path:
 * see scrollToLatest and completionVerifyDesired); it re-clamps to whatever
 * the settled maxScroll is once the re-wrapped child layout commits.
 */
export const VERIFY_SETTLED_BOTTOM = Number.POSITIVE_INFINITY

/**
 * One deferred anchor-verification pass (see adjustScrollTop): re-clamp the
 * anchor's desired scroll position against the CURRENT maxScroll and return
 * the scrollTop to write, or null when the settled position already matches
 * the re-clamped desired value within `epsilon` (no write, so no
 * programmatic-flag arming). Exported for direct unit testing.
 */
export const computeAnchorVerifyCorrection = (
  desired: number,
  scrollTop: number,
  maxScroll: number,
  epsilon: number,
): number | null => {
  // The settled-bottom desired (VERIFY_SETTLED_BOTTOM) is one-directional:
  // it only ever pushes the position UP toward a settled bottom that lies
  // below the current position (the width-change re-pin path, where the
  // re-wrapped layout landed after the ease started and the final tick
  // stopped short of the grown bottom). When the settled maxScroll is
  // BELOW the position, the position overshot a transient bottom the ease
  // pinned it to (streaming growth bumped maxScroll, then the
  // estimate-to-real transition collapsed it back); pulling the position
  // down to the settled maxScroll is the visible snap-back-up glitch, so
  // no correction is applied — the box's own re-clamp settles it.
  if (desired === VERIFY_SETTLED_BOTTOM && maxScroll < scrollTop) {
    return null
  }
  const target = clampScrollValue(desired, maxScroll)
  if (Math.abs(scrollTop - target) <= epsilon) return null
  return target
}

/** Verdict of the anchor-verify movement guard for one deferred pass. */
export type AnchorVerifyGuardVerdict =
  | 'proceed'
  | 'partially-applied'
  | 'newer-intent'

/**
 * Classify the settled scroll position for one deferred anchor-verification
 * pass (see scheduleAnchorVerify): 'proceed' when the write landed, none was
 * attempted, or it was silently clamped back to its pre-write value (a
 * swallowed residual to recover, not newer intent); 'partially-applied' when
 * the position stopped between preWrite and lastWritten (part of the
 * compensation landed, the rest is still owed; a partial clamp can never
 * carry the position past lastWritten); 'newer-intent' when the position
 * moved outside their span — a newer scroll intent owns it. Exported for
 * direct unit testing.
 */
export const computeAnchorVerifyGuard = (
  position: number,
  lastWritten: number | null,
  preWrite: number,
  epsilon: number,
): AnchorVerifyGuardVerdict => {
  if (lastWritten === null) return 'proceed'
  if (Math.abs(position - lastWritten) <= epsilon) return 'proceed'
  // The position moved off the written value; a write that was silently
  // clamped leaves it parked at its pre-write value, which is a swallowed
  // residual to recover — not a newer scroll intent.
  if (Math.abs(position - preWrite) <= epsilon) return 'proceed'
  // Partially applied: the position moved off the pre-write value toward
  // the written target but stopped short of it (a clamp against
  // partway-settled geometry applies part of the compensation). The
  // remaining residual toward `desired` is still owed — not a newer
  // scroll intent.
  if (
    position > Math.min(preWrite, lastWritten) &&
    position < Math.max(preWrite, lastWritten)
  ) {
    return 'partially-applied'
  }
  return 'newer-intent'
}

/** Gate verdict for one deferred anchor-verification pass (see `step` in
 * scheduleAnchorVerify). */
export type AnchorVerifyStepGate =
  | 'owns-chain'
  | 'superseded-chain'
  | 'stale-scrollbox'

/**
 * Classify whether one deferred anchor-verification pass may proceed to its
 * scrollTop write (see `step` in scheduleAnchorVerify): 'owns-chain' when the
 * pass still owns the ref slot AND the scrollbox it scheduled against is
 * still mounted; 'superseded-chain' when a reentrant cancel/schedule replaced
 * or cleared the slot (the dead chain must not write, re-arm, or touch the
 * ref — it would self-perpetuate alongside its successor and corrupt the
 * programmatic-flag attribution invariant); 'stale-scrollbox' when a remount
 * replaced the box, so the stale desired value must not be re-applied to the
 * fresh instance's geometry. Exported for direct unit testing.
 */
export const classifyAnchorVerifyStepGate = (
  currentChain: object | null,
  pending: object,
  liveScrollbox: object | null,
  chainScrollbox: object,
): AnchorVerifyStepGate => {
  if (currentChain !== pending) return 'superseded-chain'
  if (liveScrollbox !== chainScrollbox) return 'stale-scrollbox'
  return 'owns-chain'
}

/** Verdict of adjustScrollTop's mid-animation fold gate. */
export type AnimationFoldGate = 'fold-into-animation' | 'direct-write'

/**
 * Classify whether adjustScrollTop's compensating-anchor write may fold into
 * the in-flight animation target instead of writing scrollTop directly (see
 * adjustScrollTop in useChatScrollbox): 'fold-into-animation' when a
 * live-instance animation is in flight (it owns scrollTop and its completion
 * defers re-verification of the folded desired value); 'direct-write' when
 * none is armed or the armed animation targets a dead post-remount instance —
 * its next tick aborts on the instance guard without writing the fresh box,
 * so folding a delta into it would silently drop it. Exported for direct
 * unit testing.
 */
export const classifyAnimationFoldGate = (
  animationFrameArmed: boolean,
  animationScrollbox: object | null,
  liveScrollbox: object | null,
): AnimationFoldGate => {
  if (!animationFrameArmed) return 'direct-write'
  if (animationScrollbox === null || liveScrollbox === null) {
    return 'direct-write'
  }
  if (animationScrollbox !== liveScrollbox) return 'direct-write'
  return 'fold-into-animation'
}

/** Verdict of the animation loop's post-write ownership re-check. */
export type AnimationRearmGate = 'owns-loop' | 'superseded-loop'

/**
 * Classify whether one animation frame may re-arm its frame timer after its
 * programmatic scrollTop write (see `animate` in useChatScrollbox):
 * 'owns-loop' while this animation's token is still current; 'superseded-loop'
 * when a reentrant cancelAnimation or superseding animateScrollTo took (or
 * cleared) ownership inside the write's synchronous 'change' dispatch — a
 * superseded loop must neither re-arm nor touch the newer owner's refs, or it
 * would resurrect and keep writing programmatic frames toward a stale target.
 * Exported for direct unit testing.
 */
export const classifyAnimationRearmGate = (
  currentToken: object | null,
  ownToken: object,
): AnimationRearmGate => {
  if (currentToken !== ownToken) return 'superseded-loop'
  return 'owns-loop'
}

/** Verdict of the scrollbar 'change' movement guard. */
export type ScrollChangeMovement = 'moved' | 'geometry-only'

/**
 * Classify a scrollbar 'change' event by how far the position moved since the
 * last observed event (see handleScrollChange in useChatScrollbox):
 * 'geometry-only' when the position sits within `epsilon` of the previously
 * observed value — during message-append reflow the geometry is transient and
 * a movement-less 'change' event can momentarily report a position within
 * SCROLL_NEAR_BOTTOM_THRESHOLD of a transient maxScroll; re-arming follow on
 * such an event would snap a scrolled-up user back to the bottom via the
 * auto-scroll effect. A real position movement beyond epsilon is 'moved' and
 * keeps the exact genuine-user-scroll behavior (cancel animation + anchor
 * verify, re-arm follow = isNearBottom). Exported for direct unit testing.
 */
export const classifyScrollChangeMovement = (
  current: number,
  lastObserved: number,
  epsilon: number,
): ScrollChangeMovement => {
  if (Math.abs(current - lastObserved) <= epsilon) return 'geometry-only'
  return 'moved'
}

/**
 * The desired destination an animation's final tick defers re-verification
 * for (see animateScrollTo in useChatScrollbox): a folded anchor
 * compensation's desired wins, and otherwise a re-pin animation whose goal is
 * "the bottom" (scrollToLatest) defers verification of the SETTLED bottom
 * (VERIFY_SETTLED_BOTTOM) — the re-wrapped child layout producing the new
 * maxScroll can land after the ease started, and deferring re-pins to the new
 * bottom instead of letting a short final tick silently disable auto-follow.
 * When the layout had not landed by the final tick, the chain simply finds
 * nothing to correct. Exported for direct unit testing.
 */
export const completionVerifyDesired = (
  foldedDesired: number | null,
  verifySettledBottom: boolean,
): number | null => {
  if (foldedDesired !== null) return foldedDesired
  return verifySettledBottom ? VERIFY_SETTLED_BOTTOM : null
}

/**
 * The desired destination an in-flight animation carries after a
 * compensating anchor folds into it (see adjustScrollTop's
 * fold-into-animation path in useChatScrollbox): folding into a re-pin
 * animation (scrollToLatest) must preserve its settled-bottom completion
 * verification rather than overwrite it with the finite folded target — a
 * finite desired re-clamps to itself, short of the grown bottom, silently
 * disabling auto-follow. Folding into an ordinary animation keeps the finite
 * folded target as the verify desired. Exported for direct unit testing.
 */
export const foldAnimationVerifyDesired = (
  foldedTarget: number,
  animationVerifySettledBottom: boolean,
): number =>
  animationVerifySettledBottom ? VERIFY_SETTLED_BOTTOM : foldedTarget

/**
 * Coalesce a newly scheduled anchor verification with a still-pending chain
 * (see scheduleAnchorVerify): return the desired destination the merged
 * chain should verify against settled geometry.
 *
 * When the prior chain has not yet run a pass AND no newer scroll intent has
 * moved the position past its write's span (the write landed, was silently
 * clamped, or was only PARTIALLY applied against partway-settled geometry),
 * its residual is still owed: stack the new anchor's delta (`desired -
 * preWrite`) on top of the prior desired so the merged chain re-applies both.
 * In every other state the new `desired`, computed from the current position,
 * already reflects reality and the prior chain is dropped.
 *
 * A pending chain also belongs to the scrollbox instance it was scheduled
 * against: when both instances are provided and differ (a remount), the prior
 * chain is dropped so the dead box's desired destination is never stacked
 * onto the fresh instance's chain.
 *
 * A settled-bottom verification (VERIFY_SETTLED_BOTTOM, the width-change
 * re-pin path) coalesces by subsumption rather than stacking: a new
 * settled-bottom chain subsumes any owed numeric residual (a finite desired
 * re-clamps to at most the settled maxScroll, exactly the bottom the chain
 * re-pins to), and a pending settled-bottom chain is superseded by a newer
 * numeric anchor intent (the anchor write is the newer scroll intent and
 * carries its own deferred verification). Exported for direct unit testing.
 */
export const coalesceAnchorVerifyDesired = (
  prior: {
    passes: number
    lastWritten: number | null
    preWrite: number
    desired: number
    /** The scrollbox instance the pending chain was scheduled against
     * (compared by identity only; see the remount gate below). */
    scrollbox?: object
  } | null,
  desired: number,
  preWrite: number,
  epsilon: number,
  /** The scrollbox instance the NEW anchor was scheduled against. */
  scrollbox?: object,
): number => {
  if (prior === null || prior.passes !== 0) return desired
  // A settled-bottom verification subsumes any owed numeric residual: a
  // finite desired re-clamps to at most the settled maxScroll, which is
  // exactly the bottom this chain re-pins to.
  if (desired === VERIFY_SETTLED_BOTTOM) return VERIFY_SETTLED_BOTTOM
  if (
    scrollbox !== undefined &&
    prior.scrollbox !== undefined &&
    prior.scrollbox !== scrollbox
  ) {
    // The pending chain belongs to a dead scrollbox instance (a remount
    // swapped the instance): never stack the new anchor onto it.
    return desired
  }
  // Conversely, a pending settled-bottom chain is superseded by a newer
  // numeric anchor intent: the anchor write is the newer scroll intent and
  // carries its own deferred verification, so it must not be folded into a
  // re-pin that would override it.
  if (prior.desired === VERIFY_SETTLED_BOTTOM) return desired
  // Only a newer scroll intent (the position moved outside the prior
  // write's preWrite..lastWritten span) drops the owed residual: a landed,
  // silently-clamped, or partially-applied prior write still owes its
  // residual, which stacks beneath the new anchor's delta.
  if (
    computeAnchorVerifyGuard(
      preWrite,
      prior.lastWritten,
      prior.preWrite,
      epsilon,
    ) === 'newer-intent'
  ) {
    return desired
  }
  return prior.desired + (desired - preWrite)
}

/**
 * Carry a still-pending anchor-verify chain's owed residual into a scroll
 * animation that is taking over the position (see animateScrollTo and
 * adjustScrollTop's fold-into-animation path in useChatScrollbox): return
 * the merged desired destination the animation must carry — the prior desired
 * plus the animation's intended delta, exactly coalesceAnchorVerifyDesired's
 * stacking semantics — or null when nothing is carried. Unconditionally
 * cancelling the chain on animation takeover discards a clamped/partially
 * applied residual permanently. The guard consult reads `position` at
 * takeover time: the animation's own frames are themselves a newer scroll
 * intent once they start writing, so the residual must be captured while the
 * position still sits within the prior write's span. Exported for direct
 * unit testing.
 */
export const carryPendingVerifyResidual = (
  prior: Parameters<typeof coalesceAnchorVerifyDesired>[0],
  animationTarget: number,
  position: number,
  epsilon: number,
  scrollbox?: object,
): number | null => {
  if (prior === null || prior.passes !== 0) return null
  const merged = coalesceAnchorVerifyDesired(
    prior,
    animationTarget,
    position,
    epsilon,
    scrollbox,
  )
  // merged === animationTarget means nothing is owed beyond the animation's
  // own destination (no pending chain, nothing stacked, a superseded
  // settled-bottom prior, or a prior desired already achieved at the
  // current position).
  return merged === animationTarget ? null : merged
}

/**
 * The ease target an animation that just captured a pending anchor-verify
 * residual must ease toward (see animateScrollTo in useChatScrollbox):
 * carryPendingVerifyResidual's merged destination already includes the
 * animation's intended delta from the current position, so easing toward the
 * raw `targetScroll` would apply the residual as a discrete post-animation
 * snap. With no carried residual the raw target is used unchanged. Exported
 * for direct unit testing.
 */
export const easeTargetWithCarriedResidual = (
  targetScroll: number,
  carriedDesired: number | null,
): number => (carriedDesired !== null ? carriedDesired : targetScroll)

/**
 * Carry an outgoing in-flight animation's unfulfilled desired destination
 * into the animation superseding it (see animateScrollTo in
 * useChatScrollbox): return the merged destination the superseding animation
 * must carry — the prior desired plus the superseding animation's intended
 * delta, exactly coalesceAnchorVerifyDesired's stacking semantics — or null
 * when nothing is carried. This keeps a residual carried from a pending
 * anchor-verify chain (animationDesiredRef) alive across an
 * animation→animation takeover: cancelAnimation() nulls that ref, so an
 * uncarried residual would be silently destroyed and the viewport jump by it
 * when the superseding animation completes. A prior settled-bottom desired
 * is superseded rather than carried; a desired already achieved at the
 * current position carries nothing. Exported for direct unit testing.
 */
export const carrySupersededAnimationResidual = (
  priorDesired: number | null,
  animationTarget: number,
  position: number,
  epsilon: number,
): number | null => {
  if (priorDesired === null) return null
  // A pending settled-bottom verification is superseded by a newer numeric
  // animation intent (the same rule coalesceAnchorVerifyDesired applies to a
  // numeric anchor write); a re-pin animation subsumes any owed residual
  // through its own settled-bottom completion verification.
  if (priorDesired === VERIFY_SETTLED_BOTTOM) return null
  const merged = priorDesired + (animationTarget - position)
  // merged === animationTarget means the prior desired was already achieved
  // at the current position: nothing is owed beyond the animation's own
  // destination.
  if (Math.abs(merged - animationTarget) <= epsilon) return null
  return merged
}

/**
 * Perform one programmatic scrollTop write with leak-safe attribution.
 *
 * The programmatic flag must be armed BEFORE the write so its synchronous
 * 'change' handler attributes the write as programmatic. But OpenTUI can
 * silently clamp the assignment against stale geometry: no 'change' event
 * fires and nothing consumes the flag, which would then misattribute the
 * next genuine user scroll as programmatic. The position is therefore read
 * back after the assignment — through the canonical verticalScrollBar
 * .scrollPosition source, since scrollTop transiently diverges right after a
 * programmatic write and a divergent readback would misreport a landed write
 * as unmoved — and the flag is cleared whenever the write did not move it.
 * Movement is judged with ANCHOR_VERIFY_EPSILON, the same epsilon every other
 * position comparison in this data flow uses (the scrollbar source can report
 * sub-row/float drift, e.g. 149.9999 vs 150). Returns true when the write
 * moved the position beyond that epsilon. `follow` sets the follow intent
 * consumed together with the flag; `undefined` arms the LIVE follow state
 * (`liveFollow`) instead of leaving a stale ref value in place. A write that
 * does NOT move the position also rolls the follow mutation back: with no
 * consuming 'change' event, a follow value armed by this write must not
 * survive it. Exported for direct unit testing.
 */
export const applyProgrammaticScrollTop = (
  scrollbox: {
    scrollTop: number
    verticalScrollBar: { scrollPosition: number }
  },
  next: number,
  follow: boolean | undefined,
  liveFollow: boolean,
  programmaticScrollRef: { current: boolean },
  programmaticFollowRef: { current: boolean },
): boolean => {
  // Judge movement through the canonical scroll-position source: scrollTop
  // transiently diverges right after a programmatic write, so both the
  // pre-write value and the readback must come from the same scrollbar source
  // the 'change' handler (which consumes the flag) reports through.
  const before = scrollbox.verticalScrollBar.scrollPosition
  // Resolve the follow intent this write arms for its consuming 'change'
  // event: an explicit `follow` wins, and `undefined` arms the caller's LIVE
  // follow state so a follow-undefined write can never consume a stale
  // intent left in the ref by an earlier write.
  const armedFollow = follow ?? liveFollow
  // Snapshot the pre-write ref value so a failed write can roll the mutation
  // back: a silently-clamped/no-op write emits no consuming 'change' event,
  // so an armed follow value must not survive it.
  const prevFollow = programmaticFollowRef.current
  programmaticFollowRef.current = armedFollow
  programmaticScrollRef.current = true
  scrollbox.scrollTop = next
  if (
    Math.abs(scrollbox.verticalScrollBar.scrollPosition - before) <=
    ANCHOR_VERIFY_EPSILON
  ) {
    programmaticScrollRef.current = false
    programmaticFollowRef.current = prevFollow
    return false
  }
  return true
}

/**
 * Manages scroll behavior for the chat scrollbox with smooth animations and auto-scroll.
 *
 * @param scrollRef - Reference to the scrollbox component
 * @param messages - Array of chat messages (triggers auto-scroll on change)
 * @param isUserCollapsing - Callback to check if user is actively collapsing/expanding toggles.
 *                          When true, auto-scroll is temporarily suppressed to prevent jarring UX.
 * @returns Scroll management functions and state
 */
export const useChatScrollbox = (
  scrollRef: React.RefObject<ScrollBoxRenderable | null>,
  messages: ChatMessage[],
  isUserCollapsing: () => boolean,
) => {
  const autoScrollEnabledRef = useRef<boolean>(true)
  // The last scrollbar position the 'change' handler observed, seeded at
  // subscribe time with the live position: a movement-less 'change' event
  // (transient reflow geometry during message-append) must be classifiable
  // as geometry-only from the very first event after subscription.
  const lastObservedScrollRef = useRef<number | null>(null)
  const programmaticScrollRef = useRef<boolean>(false)
  const programmaticFollowRef = useRef<boolean>(false)
  const animationFrameRef = useRef<number | null>(null)
  // The in-flight animateScrollTo target, read EVERY frame by the animation
  // loop: an anchor compensation landing mid-flight is honored as an offset
  // added to this target instead of being clobbered.
  const animationTargetRef = useRef<number | null>(null)
  // The unclamped desired destination this animation's final tick defers
  // re-verification for (null when none applies): a folded anchor
  // compensation or a carried residual. Deliberately NOT clamped at fold
  // time — the child layout producing the new maxScroll may land later —
  // so range safety comes from the loop's per-frame clamp and the
  // completion defers re-verification via scheduleAnchorVerify.
  const animationDesiredRef = useRef<number | null>(null)
  // The scrollbox instance the in-flight animation was started against (null
  // when none is in flight): adjustScrollTop's fold gate consults this so a
  // compensating anchor is never folded into a doomed post-remount
  // animation, whose abort would silently drop the delta.
  const animationScrollboxRef = useRef<ScrollBoxRenderable | null>(null)
  // Whether the in-flight animation is a re-pin whose goal is the settled
  // bottom (scrollToLatest): the fold path consults it so a folded anchor
  // preserves the re-pin's settled-bottom verification (see
  // foldAnimationVerifyDesired) instead of overwriting it.
  const animationVerifySettledBottomRef = useRef(false)
  // Ownership token for the in-flight animation: a fresh object per
  // animateScrollTo call, cleared by cancelAnimation. The loop re-checks it
  // after every programmatic write — the write dispatches 'change'
  // synchronously, so a reentrant cancel/supersede can run inside that
  // dispatch and a superseded loop must not resurrect (see
  // classifyAnimationRearmGate).
  const animationTokenRef = useRef<object | null>(null)
  const [isAtBottom, setIsAtBottom] = useState<boolean>(true)

  const cancelAnimation = useCallback(() => {
    if (animationFrameRef.current !== null) {
      clearTimeout(animationFrameRef.current)
      animationFrameRef.current = null
    }
    // Whatever anchor compensation was folded into the cancelled animation
    // no longer applies: a cancelled animation means a newer scroll intent
    // (a new animation, a user scroll, a remount) owns the position.
    animationDesiredRef.current = null
    animationScrollboxRef.current = null
    animationTokenRef.current = null
    animationVerifySettledBottomRef.current = false
  }, [])

  // Pending deferred verification of the most recent compensating anchor
  // write (see adjustScrollTop): re-checks the settled position and
  // re-applies any clamped-away residual, bounded in passes and cancelled by
  // any newer scroll intent.
  const anchorVerifyRef = useRef<{
    timer: ReturnType<typeof setTimeout> | null
    passes: number
    lastWritten: number | null
    /** Position read through the scrollbar source immediately before the
     * most recent verified write (each corrective pass refreshes it), so a
     * silently-clamped or partially-applied write is recognized as a
     * swallowed residual instead of newer scroll intent. */
    preWrite: number
    /** The unclamped desired destination this chain verifies against
     * settled geometry; coalesced with the prior chain's desired when a new
     * anchor is scheduled while this chain is still pending its first pass
     * (see coalesceAnchorVerifyDesired). */
    desired: number
    /** The scrollbox instance this chain was scheduled against: the
     * coalescing gate refuses to stack a new anchor scheduled against a
     * different (post-remount) instance onto this chain. */
    scrollbox: ScrollBoxRenderable
  } | null>(null)

  const cancelAnchorVerify = useCallback((): void => {
    const pending = anchorVerifyRef.current
    if (pending?.timer != null) clearTimeout(pending.timer)
    anchorVerifyRef.current = null
  }, [])

  // Programmatic scrollTop write with leak-safe flag attribution (see
  // applyProgrammaticScrollTop): the flag survives the write only when the
  // write actually moved the position, so a no-op or silently-clamped write
  // can never leave the flag armed with no 'change' event to consume it.
  const applyProgrammaticWrite = useCallback(
    (
      scrollbox: ScrollBoxRenderable,
      next: number,
      follow?: boolean,
    ): boolean =>
      applyProgrammaticScrollTop(
        scrollbox,
        next,
        follow,
        // The LIVE follow state: a follow-undefined write (the auto-scroll
        // clamp/pin path) arms this for its consuming 'change' event
        // instead of leaving a stale ref value in place.
        autoScrollEnabledRef.current,
        programmaticScrollRef,
        programmaticFollowRef,
      ),
    [],
  )

  const scheduleAnchorVerify = useCallback(
    (
      scrollbox: ScrollBoxRenderable,
      desired: number,
      written: number,
      preWrite: number,
      follow?: boolean,
    ): void => {
      // Coalesce with a still-pending chain instead of unconditionally
      // discarding it: a prior silently-clamped write whose residual is not
      // yet re-applied would otherwise be dropped permanently by the next
      // anchor within ANCHOR_VERIFY_DELAY_MS, producing a one-off viewport
      // jump. Stacking applies exactly when the residual is still owed; in
      // every other state the prior chain is dropped as before.
      const prior = anchorVerifyRef.current
      // Pass this chain's owning instance so coalesceAnchorVerifyDesired can
      // refuse to stack this anchor onto a chain that belongs to a dead
      // scrollbox (a remount swapped the instance before the poll's
      // unsubscribe observed the swap).
      const desiredToVerify = coalesceAnchorVerifyDesired(
        prior,
        desired,
        preWrite,
        ANCHOR_VERIFY_EPSILON,
        scrollbox,
      )
      cancelAnchorVerify()
      const pending = {
        timer: null as ReturnType<typeof setTimeout> | null,
        passes: 0,
        lastWritten: written as number | null,
        preWrite,
        desired: desiredToVerify,
        scrollbox,
      }
      anchorVerifyRef.current = pending

      const step = (): void => {
        pending.timer = null
        // Ownership guard: this pass may only write or re-arm while its chain
        // object is still the one recorded in anchorVerifyRef AND the box it
        // was scheduled against is still the mounted instance — a superseded
        // chain that kept going would self-perpetuate alongside its successor
        // and corrupt the programmatic-flag attribution invariant.
        const gate = classifyAnchorVerifyStepGate(
          anchorVerifyRef.current,
          pending,
          scrollRef.current,
          scrollbox,
        )
        // Superseded: the ref slot belongs to the newer chain (or nothing),
        // so this pass must not touch it — just stop.
        if (gate === 'superseded-chain') return
        // A remount replaced the box the anchor was written against: the new
        // instance's geometry starts fresh, so the stale desired value must
        // not be re-applied to it.
        if (gate === 'stale-scrollbox') {
          anchorVerifyRef.current = null
          return
        }
        // Read the settled position through the canonical source: scrollTop
        // can transiently diverge from the scrollbar position right after a
        // programmatic write — the exact window in which this pass runs.
        const position = scrollbox.verticalScrollBar.scrollPosition
        // Movement is classified by the shared guard: a write silently
        // clamped (or partially applied against partway-settled geometry) is
        // a residual this state machine exists to re-apply, not a newer
        // scroll intent.
        if (
          computeAnchorVerifyGuard(
            position,
            pending.lastWritten,
            pending.preWrite,
            ANCHOR_VERIFY_EPSILON,
          ) === 'newer-intent'
        ) {
          anchorVerifyRef.current = null
          return
        }
        const maxScroll = Math.max(
          0,
          scrollbox.scrollHeight - scrollbox.viewport.height,
        )
        const correction = computeAnchorVerifyCorrection(
          pending.desired,
          position,
          maxScroll,
          ANCHOR_VERIFY_EPSILON,
        )
        // Already settled at the re-clamped desired position (or the pass
        // budget is exhausted): stop verifying.
        if (
          correction === null ||
          pending.passes >= ANCHOR_VERIFY_MAX_PASSES
        ) {
          anchorVerifyRef.current = null
          return
        }
        pending.lastWritten = correction
        // Refresh the pre-write anchor to the position this corrective write
        // starts from, so the next pass's guard classifies the write against
        // ITS OWN pre-write value instead of the original write's span.
        pending.preWrite = position
        pending.passes += 1
        // Attribute the corrective write as programmatic with the anchor's
        // follow intent, mirroring the original anchor write, so the change
        // handler does not misread it as a user scroll.
        applyProgrammaticWrite(
          scrollbox,
          correction,
          follow ?? autoScrollEnabledRef.current,
        )
        // The write dispatches 'change' synchronously, so a reentrant
        // cancel/schedule can replace or clear anchorVerifyRef.current before
        // the assignment returns: re-check ownership before re-arming.
        if (anchorVerifyRef.current !== pending) return
        pending.timer = setTimeout(step, ANCHOR_VERIFY_DELAY_MS)
      }

      pending.timer = setTimeout(step, ANCHOR_VERIFY_DELAY_MS)
    },
    [scrollRef, cancelAnchorVerify, applyProgrammaticWrite],
  )

  const animateScrollTo = useCallback(
    (
      targetScroll: number,
      duration = DEFAULT_SCROLL_ANIMATION_DURATION_MS,
      enableFollowOnComplete = false,
      verifySettledBottomOnComplete = false,
    ) => {
      const scrollbox = scrollRef.current
      if (!scrollbox) return

      // A superseding animateScrollTo takes ownership from an in-flight
      // animation. The outgoing animation may itself carry an unfulfilled
      // desired destination (see animationDesiredRef): cancelAnimation()
      // below nulls that ref, so it must be captured FIRST, and only when the
      // outgoing animation targeted THIS live scrollbox instance — a desired
      // belonging to a dead post-remount instance must never be re-applied to
      // the fresh box.
      const supersededDesired =
        animationScrollboxRef.current === scrollbox
          ? animationDesiredRef.current
          : null
      cancelAnimation()
      // A still-pending anchor-verify chain that has not yet run a pass and
      // whose write was silently clamped or only partially applied still owes
      // its residual: capture it BEFORE this animation's frames write (while
      // the position still sits within the prior write's span) and carry it
      // instead of discarding the chain — a discarded residual is the
      // one-off viewport jump the chain exists to prevent. A re-pin animation
      // (verifySettledBottomOnComplete) subsumes the residual instead of
      // stacking it: its settled-bottom goal already covers any owed residual.
      // The ease start is read through the canonical scrollbar source — an
      // animation started inside the post-write divergence window would ease
      // from a stale position and snap the viewport.
      const startScroll = readCanonicalScrollPosition(scrollbox)
      // The outgoing animation's owed residual, stacked with this
      // animation's intended delta from the current position (the same
      // coalesceAnchorVerifyDesired stacking semantics).
      const supersededCarried = carrySupersededAnimationResidual(
        supersededDesired,
        targetScroll,
        startScroll,
        ANCHOR_VERIFY_EPSILON,
      )
      // The pending chain's residual, stacked on top of the destination
      // above so both owed residuals ride the same ease and the same
      // completion verification.
      const mergedTarget = supersededCarried ?? targetScroll
      const carriedDesired = verifySettledBottomOnComplete
        ? null
        : (carryPendingVerifyResidual(
              anchorVerifyRef.current,
              mergedTarget,
              startScroll,
              ANCHOR_VERIFY_EPSILON,
              scrollbox,
            ) ??
          (supersededCarried !== null ? mergedTarget : null))
      // The carried residual now rides this animation's frames and its
      // completion's deferred verification; the pending chain itself is
      // superseded so it cannot fight the animation's frames.
      cancelAnchorVerify()
      // The carried residual is folded into the ease target itself (see
      // easeTargetWithCarriedResidual) rather than applied as a
      // post-animation snap; the merged destination also becomes the
      // unclamped desired this final tick defers re-verification for (see
      // completionVerifyDesired), so a clamp-swallowed residual is
      // re-applied against settled geometry instead of being dropped.
      animationTargetRef.current = easeTargetWithCarriedResidual(
        targetScroll,
        carriedDesired,
      )
      animationDesiredRef.current = carriedDesired
      // Record whether this animation is a re-pin whose goal is the settled
      // bottom (scrollToLatest): the fold path consults it to preserve the
      // settled-bottom verification (see foldAnimationVerifyDesired).
      animationVerifySettledBottomRef.current = verifySettledBottomOnComplete
      // Record the instance this animation owns scrollTop for: the fold gate
      // in adjustScrollTop consults it so a compensating anchor is never
      // folded into an animation that a remount has already doomed.
      animationScrollboxRef.current = scrollbox
      // A fresh ownership token per animation: the loop's post-write re-check
      // (classifyAnimationRearmGate) distinguishes THIS animation from any
      // reentrant cancel/supersede inside a write's 'change' dispatch.
      const animationToken = {}
      animationTokenRef.current = animationToken

      // The ease start was already read through the canonical scrollbar
      // source above, before the pending chain's residual was captured.
      const startTime = Date.now()
      const frameInterval = ANIMATION_FRAME_INTERVAL_MS

      const animate = () => {
        // A remount swapped the box mid-flight: writing to the dead instance
        // would never be observed by the new subscription, and re-arming the
        // programmatic flag each tick would misattribute the new box's first
        // genuine user scroll. Abort instead of writing to a stale instance.
        if (scrollRef.current !== scrollbox) {
          animationFrameRef.current = null
          // Drop the target/desired/instance state alongside the frame timer
          // so a compensating anchor arriving after this abort cannot fold
          // into dead state belonging to the dead instance.
          animationTargetRef.current = null
          animationDesiredRef.current = null
          animationScrollboxRef.current = null
          animationTokenRef.current = null
          animationVerifySettledBottomRef.current = false
          return
        }
        const elapsed = Date.now() - startTime
        const progress = Math.min(elapsed / duration, 1)
        const easedProgress = easeOutCubic(progress)
        // Read the target EVERY frame: an anchor compensation landing
        // mid-flight mutates animationTargetRef, so easing toward the current
        // target keeps the viewport stable instead of snapping to the stale
        // pre-compensation destination when the animation completes.
        const frameTarget = animationTargetRef.current ?? targetScroll
        // Clamp every frame's write — including the final tick — to the live
        // [0, maxScroll] range: a mid-flight anchor compensation can redirect
        // the target above maxScroll, and re-reading each frame honors
        // geometry changes during the animation.
        const maxScroll = Math.max(
          0,
          scrollbox.scrollHeight - scrollbox.viewport.height,
        )
        const newScroll = clampScrollValue(
          computeAnimationFrameScroll(
            startScroll,
            frameTarget,
            easedProgress,
          ),
          maxScroll,
        )

        if (progress < 1) {
          applyProgrammaticWrite(scrollbox, newScroll, enableFollowOnComplete)
          // The write dispatches 'change' synchronously, so a reentrant
          // cancelAnimation or superseding animateScrollTo can take (or
          // clear) ownership before the assignment returns: re-check before
          // re-arming, and never overwrite the newer owner's frame timer.
          if (
            classifyAnimationRearmGate(
              animationTokenRef.current,
              animationToken,
            ) === 'superseded-loop'
          ) {
            return
          }
          animationFrameRef.current = setTimeout(animate, frameInterval) as any
        } else {
          // Final tick: capture the pre-write position through the canonical
          // scrollbar source so the deferred verification below can
          // distinguish a silently-clamped final write (a swallowed residual:
          // the position never left its pre-write value) from newer scroll
          // intent.
          const preWrite = scrollbox.verticalScrollBar.scrollPosition
          applyProgrammaticWrite(scrollbox, newScroll, enableFollowOnComplete)
          // The final write also dispatches 'change' synchronously: a
          // reentrant cancel/supersede has already taken (or cleared)
          // ownership, so the completed loop must not clobber the newer
          // owner's refs nor defer verification toward this animation's
          // stale desired — just stop.
          if (
            classifyAnimationRearmGate(
              animationTokenRef.current,
              animationToken,
            ) === 'superseded-loop'
          ) {
            return
          }
          animationFrameRef.current = null
          animationTargetRef.current = null
          animationScrollboxRef.current = null
          animationTokenRef.current = null
          animationVerifySettledBottomRef.current = false
          // The final write can land against geometry that was still stale
          // (a folded desired clamped against pre-commit geometry, or a
          // re-pin ease that started before the new layout committed and
          // landed short of the settled bottom, silently disabling
          // auto-follow): defer re-verification against settled geometry so
          // the residual is re-applied instead of dropped — the same defense
          // the direct-write path applies to every compensating write.
          const desired = completionVerifyDesired(
            animationDesiredRef.current,
            verifySettledBottomOnComplete,
          )
          animationDesiredRef.current = null
          if (desired !== null) {
            scheduleAnchorVerify(
              scrollbox,
              desired,
              newScroll,
              preWrite,
              enableFollowOnComplete,
            )
          }
        }
      }

      animate()
    },
    [
      scrollRef,
      cancelAnimation,
      cancelAnchorVerify,
      applyProgrammaticWrite,
      scheduleAnchorVerify,
    ],
  )

  /**
   * Re-pin to the bottom (the width-change re-pin path: the user's intent is
   * "watch the latest"). The maxScroll read here can be stale — the
   * re-wrapped child layout can land after this animation starts — so the
   * animation defers verification of the SETTLED bottom, re-pinning to the
   * settled maxScroll with the follow intent armed instead of letting a
   * short final tick silently disable auto-follow.
   */
  const scrollToLatest = useCallback((): void => {
    const scrollbox = scrollRef.current
    if (!scrollbox) return

    const maxScroll = Math.max(
      0,
      scrollbox.scrollHeight - scrollbox.viewport.height,
    )
    animateScrollTo(
      maxScroll,
      DEFAULT_SCROLL_ANIMATION_DURATION_MS,
      true,
      true,
    )
  }, [scrollRef, animateScrollTo])

  // Viewport-windowing scroll anchoring: shift scrollTop by `delta` so the
  // viewport keeps showing the same content when a message above it changes
  // height. The write is attributed as programmatic and preserves the follow
  // intent the anchor had: at-bottom keeps following, scrolled-up stays
  // unfollowed.
  const adjustScrollTop = useCallback(
    (delta: number, opts?: { follow?: boolean }): void => {
      const scrollbox = scrollRef.current
      if (!scrollbox) return

      // A compensating anchor that lands mid-animation folds into the
      // in-flight target instead of writing scrollTop, so the ease is nudged
      // rather than clobbered (the animation loop owns scrollTop and the
      // follow flag for its remaining frames). Do not cancel the animation or
      // touch autoScrollEnabledRef here.
      //
      // The fold is gated on the animation still targeting the LIVE scrollbox
      // instance (classifyAnimationFoldGate): after a remount swap the stale
      // animation's frame timer stays armed briefly, and folding into that
      // doomed animation would silently drop the delta — it falls through to
      // the direct-write path below against the live instance instead.
      if (
        classifyAnimationFoldGate(
          animationFrameRef.current !== null,
          animationScrollboxRef.current,
          scrollbox,
        ) === 'fold-into-animation'
      ) {
        // A still-pending anchor-verify chain whose write was silently
        // clamped or only partially applied still owes its residual: capture
        // it BEFORE the animation's remaining frames write and fold it into
        // the redirected destination (carryPendingVerifyResidual) instead of
        // dropping it — a dropped residual is the one-off viewport jump the
        // chain exists to prevent. The pending chain is then superseded so it
        // cannot fight the animation's frames.
        const position = readCanonicalScrollPosition(scrollbox)
        const foldedDesired =
          carryPendingVerifyResidual(
            anchorVerifyRef.current,
            position + delta,
            position,
            ANCHOR_VERIFY_EPSILON,
            scrollbox,
          ) ?? position + delta
        // The carried residual now rides the in-flight ease and its
        // completion's deferred verification; the pending chain itself is
        // superseded so it cannot fight the animation's frames.
        cancelAnchorVerify()
        if (animationTargetRef.current !== null) {
          // Fold the redirected destination into the in-flight target WITHOUT
          // clamping it against the maxScroll read at fold time: the child
          // layout producing the new maxScroll may land after this fold, and
          // truncating there would silently drop the residual. Range safety
          // comes from the animation loop's per-frame clamp and the
          // completion's deferred re-verification against settled geometry.
          animationTargetRef.current =
            animationTargetRef.current + (foldedDesired - position)
          // A fold into a re-pin animation must not overwrite the re-pin's
          // settled-bottom verification with the finite folded target — a
          // finite desired re-clamps to itself, short of the grown bottom
          // (see foldAnimationVerifyDesired).
          animationDesiredRef.current = foldAnimationVerifyDesired(
            animationTargetRef.current,
            animationVerifySettledBottomRef.current,
          )
        }
        return
      }

      const maxScroll = Math.max(
        0,
        scrollbox.scrollHeight - scrollbox.viewport.height,
      )
      // Read the position through the canonical source (the scrollbar), the
      // same source the deferred verification pass reads 32ms later, so the
      // pre-write value recorded below cannot be polluted by the transient
      // scrollTop/scrollbar divergence right after a programmatic write.
      const current = scrollbox.verticalScrollBar.scrollPosition
      // The desired (unclamped) post-compensation position: the deferred
      // verification below re-clamps it against freshly settled geometry in
      // case this write raced the layout pass producing the new maxScroll.
      const desired = current + delta
      const next = clampScrollValue(desired, maxScroll)
      // Only arm the programmatic flag when the write actually moves the
      // scroll position: a no-op assignment emits no 'change' event, so an
      // armed flag would survive and swallow the next genuine user scroll.
      if (next !== current) {
        // Re-check the instance BEFORE arming the flag / writing: a remount
        // swap between the capture above and this write would otherwise arm
        // the flag against a dead box and misattribute the new box's first
        // user scroll as programmatic.
        if (scrollRef.current !== scrollbox) return
        applyProgrammaticWrite(
          scrollbox,
          next,
          opts?.follow ?? autoScrollEnabledRef.current,
        )
      }
      // Schedule the deferred re-verification whether or not this write
      // moved the box: if the committed child layout (and thus the new
      // maxScroll) lands after this write, the compensation can be silently
      // clamped away, and re-checking against settled geometry keeps the
      // viewport stable under either commit ordering.
      scheduleAnchorVerify(scrollbox, desired, next, current, opts?.follow)
    },
    [scrollRef, scheduleAnchorVerify, cancelAnchorVerify, applyProgrammaticWrite],
  )

  const scrollUp = useCallback((): void => {
    const scrollbox = scrollRef.current
    if (!scrollbox) return

    const viewportHeight = scrollbox.viewport.height
    const maxScroll = Math.max(0, scrollbox.scrollHeight - viewportHeight)
    // The page target is computed from the canonical scrollbar position: a
    // scrollTop-derived base inside the post-write divergence window would
    // page from a stale value and snap the viewport when the canonical
    // position caught up.
    const targetScroll = computePageScrollTarget(
      readCanonicalScrollPosition(scrollbox),
      viewportHeight,
      maxScroll,
      'up',
    )
    autoScrollEnabledRef.current = false
    animateScrollTo(targetScroll)
  }, [scrollRef, animateScrollTo])

  const scrollDown = useCallback((): void => {
    const scrollbox = scrollRef.current
    if (!scrollbox) return

    const viewportHeight = scrollbox.viewport.height
    const maxScroll = Math.max(0, scrollbox.scrollHeight - viewportHeight)
    // The page target is computed from the canonical scrollbar position: a
    // scrollTop-derived base inside the post-write divergence window would
    // page from a stale value and snap the viewport when the canonical
    // position caught up.
    const targetScroll = computePageScrollTarget(
      readCanonicalScrollPosition(scrollbox),
      viewportHeight,
      maxScroll,
      'down',
    )
    animateScrollTo(
      targetScroll,
      DEFAULT_SCROLL_ANIMATION_DURATION_MS,
      targetScroll >= maxScroll,
    )
  }, [scrollRef, animateScrollTo])

  useEffect(() => {
    let handleScrollChange: (() => void) | null = null
    let subscribedBox: ScrollBoxRenderable | null = null
    let pollTimer: ReturnType<typeof setTimeout> | null = null

    const unsubscribe = () => {
      if (subscribedBox && handleScrollChange) {
        subscribedBox.verticalScrollBar.off('change', handleScrollChange)
        // The subscribed instance is going away (remount swap or unmount):
        // cancel the pending deferred anchor-verify chain — it belongs to
        // this instance, and a chain that outlives it could be coalesced
        // with a new anchor scheduled against the replacement box. The
        // per-pass instance guard and coalescing gate are backstops for the
        // window before this change is observed; cancelling here is primary.
        cancelAnchorVerify()
      }
      subscribedBox = null
      handleScrollChange = null
    }

    // Re-subscribe whenever the scrollbox instance changes: the effect deps
    // are stable so the effect runs once, but a remount can swap in a new
    // ScrollBoxRenderable — without re-subscription, isAtBottom/auto-scroll
    // would track a dead instance and the old listener would leak.
    const subscribe = (scrollbox: ScrollBoxRenderable) => {
      if (scrollbox === subscribedBox) return
      unsubscribe()
      // A remount swapped in a new instance (or the first one attached):
      // cancel any in-flight animation that captured the previous instance,
      // so its pending frame cannot re-arm the programmatic flag against the
      // new box after this subscription (the animate loop's instance guard
      // is the mid-tick backstop).
      cancelAnimation()
      // A programmatic write that landed BEFORE this subscription had no
      // 'change' listener to consume its flag (the mount poll can subscribe
      // up to MOUNT_POLL_INTERVAL_MS after it armed), so clear the flag at
      // subscription time — otherwise the next genuine user scroll would be
      // misattributed as programmatic. Re-synchronize the follow intent with
      // the live follow state too: that write also armed a follow intent no
      // event consumed.
      programmaticScrollRef.current = false
      programmaticFollowRef.current = autoScrollEnabledRef.current
      // Seed the movement guard with the LIVE position: the first post-
      // subscribe 'change' event must be judged against the position the
      // subscription attached at, not a stale default, or that first
      // geometry-only event would be misread as user movement.
      lastObservedScrollRef.current = scrollbox.verticalScrollBar.scrollPosition
      handleScrollChange = () => {
        const maxScroll = Math.max(
          0,
          scrollbox.scrollHeight - scrollbox.viewport.height,
        )
        const current = scrollbox.verticalScrollBar.scrollPosition
        const isNearBottom = computeIsNearBottom(current, maxScroll)

        if (programmaticScrollRef.current) {
          programmaticScrollRef.current = false
          autoScrollEnabledRef.current =
            programmaticFollowRef.current && isNearBottom
          setIsAtBottom(isNearBottom)
          lastObservedScrollRef.current = current
          return
        }

        // Movement guard: a 'change' event not preceded by a programmatic
        // write is only a genuine user scroll when the position actually
        // moved since the last observed event. During message-append reflow
        // the geometry is transient — the position can momentarily sit within
        // SCROLL_NEAR_BOTTOM_THRESHOLD of a transient maxScroll — so re-arming
        // follow on a movement-less event would let the 50ms auto-scroll
        // effect snap a scrolled-up user back to the bottom. A sub-row user
        // scroll (<= epsilon) is indistinguishable from geometry-only; that
        // is accepted.
        const lastObserved = lastObservedScrollRef.current
        if (
          lastObserved !== null &&
          classifyScrollChangeMovement(
            current,
            lastObserved,
            ANCHOR_VERIFY_EPSILON,
          ) === 'geometry-only'
        ) {
          lastObservedScrollRef.current = current
          return
        }
        lastObservedScrollRef.current = current
        cancelAnimation()
        // A genuine user scroll is a newer scroll intent: cancel the pending
        // anchor-verify chain alongside the animation — a surviving chain
        // would classify a position inside its write span as
        // 'partially-applied' and re-write the compensating position over the
        // user's scroll intent. The chain's own corrective writes take the
        // programmatic branch above, so this cancel fires only for genuine
        // user scrolls.
        cancelAnchorVerify()
        autoScrollEnabledRef.current = isNearBottom
        // Re-synchronize the follow intent with the live follow state after
        // a user scroll, so no later reader can observe a leftover intent
        // from an earlier programmatic write.
        programmaticFollowRef.current = isNearBottom
        setIsAtBottom((prev) => (prev === isNearBottom ? prev : isNearBottom))
      }
      subscribedBox = scrollbox
      scrollbox.verticalScrollBar.on('change', handleScrollChange)
    }

    const pollForScrollbox = (): void => {
      const current = scrollRef.current
      if (current) {
        // No-op while the same instance stays mounted; re-subscribes when a
        // remount swaps in a new instance (or attaches the first one).
        subscribe(current)
      } else {
        unsubscribe()
      }
      pollTimer = setTimeout(
        pollForScrollbox,
        subscribedBox ? REMOUNT_POLL_INTERVAL_MS : MOUNT_POLL_INTERVAL_MS,
      )
    }
    pollForScrollbox()

    return () => {
      if (pollTimer) clearTimeout(pollTimer)
      unsubscribe()
    }
    // All deps are stable (a ref object and []-dep useCallbacks), so the
    // effect runs once; the poll keeps the subscription pinned to whichever
    // scrollbox instance is currently mounted. The handler itself only reads
    // refs and uses functional setState, so a stale closure is not a concern.
  }, [scrollRef, cancelAnimation, cancelAnchorVerify])

  useEffect(() => {
    const scrollbox = scrollRef.current
    if (scrollbox) {
      const timeoutId = setTimeout(() => {
        // A remount can swap in a new ScrollBoxRenderable while this timer is
        // pending: writing to the captured dead instance would never be
        // observed by the new box's subscription, and arming the programmatic
        // flag would misattribute its first genuine user scroll. Abort
        // instead; the next messages change re-runs this effect against the
        // live instance.
        if (scrollRef.current !== scrollbox) {
          return
        }
        const maxScroll = Math.max(
          0,
          scrollbox.scrollHeight - scrollbox.viewport.height,
        )

        // Read the clamp/pin comparison position through the canonical
        // scrollbar source, the same source the 'change' handler and every
        // other scroll-position reader use: a scrollTop-based comparison
        // inside the post-write divergence window would disagree with the
        // canonical readers (e.g. clamping a position the scrollbar reports
        // as mid-range, dragging the user off the spot they scrolled to).
        const target = computeAutoScrollTarget(
          scrollbox,
          maxScroll,
          autoScrollEnabledRef.current,
          isUserCollapsing(),
        )
        // Skip the write when the position is already within epsilon of
        // the target (see shouldSkipAutoScrollWrite):
        // computeAutoScrollTarget only returns null on exact equality, and
        // re-writing the same visual position on every messages change pins
        // the position to a TRANSIENT maxScroll — when the layout settles
        // lower, the re-clamp snaps the viewport back up. The clamp path
        // (position > maxScroll) is a legitimate safety write and is never
        // skipped. Skipping also leaves the pending anchor-verify chain
        // untouched, which is correct: its own pass handles any residual.
        const position = scrollbox.verticalScrollBar.scrollPosition
        if (
          target !== null &&
          !shouldSkipAutoScrollWrite(
            position,
            target,
            maxScroll,
            ANCHOR_VERIFY_EPSILON,
          )
        ) {
          // The write helper keeps the flag armed only when the write moves
          // the position: a no-op assignment emits no 'change' event, which
          // would leave the flag armed and misattribute the next genuine user
          // scroll as programmatic. The follow intent is resolved to the LIVE
          // follow state inside the write helper: a pure clamp/pin does not
          // change follow, and a stale intent here would silently disable
          // auto-follow after a content-shrink clamp while the user was at
          // the bottom.
          const moved = applyProgrammaticWrite(scrollbox, target)
          // A MOVED clamp/pin write is a newer scroll intent: cancel the
          // pending anchor-verify chain so its corrective pass cannot re-write
          // the compensating position over this write. A no-op write moves
          // nothing, so a still-owed residual is left to its own chain.
          if (moved) cancelAnchorVerify()
        }
      }, AUTO_SCROLL_DELAY_MS)

      return () => clearTimeout(timeoutId)
    }
    return undefined
  }, [
    messages,
    scrollToLatest,
    scrollRef,
    isUserCollapsing,
    applyProgrammaticWrite,
    cancelAnchorVerify,
  ])

  useEffect(() => {
    return () => {
      cancelAnimation()
      cancelAnchorVerify()
    }
  }, [cancelAnimation, cancelAnchorVerify])

  return {
    scrollToLatest,
    scrollUp,
    scrollDown,
    adjustScrollTop,
    scrollboxProps: {},
    isAtBottom,
  }
}
