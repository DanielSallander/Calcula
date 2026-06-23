//! FILENAME: app/src/api/appearancePolicy.ts
// PURPOSE: Enterprise appearance policy (ADVISORY default) + accessibility
//          override resolution for the App Skin system.
// CONTEXT: An admin can set the DEFAULT skin for an install; the user is ALWAYS
//          free to change it (advisory only — no lock). Accessibility overrides
//          always win and can never be suppressed by policy. Mirrors the Rust
//          ManagedPolicy (camelCase) and the get_effective_appearance_policy cmd.

import { invoke } from "@tauri-apps/api/core";
import {
  registerSkin,
  getSkin,
  getActiveSkinId,
  setActiveSkin,
  hasUserChosenSkin,
  setAccessibility,
} from "../core/theme/skinLoader";
import { BUILTIN_DEFAULT_SKIN_ID } from "../core/theme/builtInSkins";
import type { Skin, AccessibilityOverride } from "../core/theme/skin";

/** Trust status of a managed (signed) skin, mirrored from the Rust TrustStatus. */
export type SkinTrust = "verified" | "firstUse" | "unsigned" | "unknown";

/**
 * Effective appearance policy returned by the Rust `get_effective_appearance_policy`
 * command. For unmanaged installs `managed` is false and the rest is empty.
 */
export interface EffectiveAppearancePolicy {
  managed: boolean;
  managedBy: string;
  registryUrl: string;
  defaultSkinId: string;
  /** The resolved org skin-pack materialized as a Skin (or null if undelivered). */
  skin: Skin | null;
  trust: SkinTrust;
  /** Publisher key fingerprint, for the provenance banner. */
  publisherFingerprint: string;
  /** Resolved version of the org skin package. */
  version: string;
}

const MANAGED_CACHE_KEY = "calcula.appearance.managedCache";
const A11Y_KEY = "calcula.appearance.a11y";

interface ManagedCache {
  defaultSkinId?: string;
  skin?: Skin;
  managedBy?: string;
}

let lastPolicy: EffectiveAppearancePolicy | null = null;

// --- Pure precedence resolver (advisory): user > org default > built-in --------

/**
 * Resolve the effective skin id. The user's explicit choice always wins over the
 * org's advisory default, which wins over the factory built-in default.
 */
export function resolveEffectiveSkinId(
  policy: { defaultSkinId?: string } | null,
  userSkinId: string | null,
  builtinDefaultId: string = BUILTIN_DEFAULT_SKIN_ID
): string {
  if (userSkinId) return userSkinId;
  if (policy?.defaultSkinId) return policy.defaultSkinId;
  return builtinDefaultId;
}

// --- Managed cache (FOUC-free next boot) ---------------------------------------

function readManagedCache(): ManagedCache | null {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(MANAGED_CACHE_KEY) : null;
    return raw ? (JSON.parse(raw) as ManagedCache) : null;
  } catch {
    return null;
  }
}

function writeManagedCache(cache: ManagedCache): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(MANAGED_CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* ignore */
  }
}

/**
 * Synchronous boot seed (called in main.tsx BEFORE initSkinLoader): register the
 * last-cached org skin and return its default id, so a managed install paints the
 * org skin with no flash. The user's persisted choice still wins inside the loader.
 */
export function getBootPreferredSkinId(): string | undefined {
  const cache = readManagedCache();
  if (!cache) return undefined;
  if (cache.skin) registerSkin(cache.skin);
  return cache.defaultSkinId || undefined;
}

// --- Accessibility (user toggles merged with OS preferences) -------------------

function readUserA11y(): AccessibilityOverride {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(A11Y_KEY) : null;
    return raw ? (JSON.parse(raw) as AccessibilityOverride) : {};
  } catch {
    return {};
  }
}

function detectOSAccessibility(): AccessibilityOverride {
  if (typeof window === "undefined" || !window.matchMedia) return {};
  const out: AccessibilityOverride = {};
  try {
    if (window.matchMedia("(prefers-contrast: more)").matches) out.highContrast = true;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) out.reducedMotion = true;
  } catch {
    /* matchMedia query unsupported */
  }
  return out;
}

/** Recompute and apply the effective accessibility override (OS + user toggles). */
export function applyAccessibilityFromPrefs(): void {
  const os = detectOSAccessibility();
  const user = readUserA11y();
  setAccessibility({ ...os, ...user }); // explicit user toggles win over OS detection
}

/** Persist the user's accessibility toggles and apply immediately. */
export function setUserAccessibility(override: AccessibilityOverride): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(A11Y_KEY, JSON.stringify(override));
  } catch {
    /* ignore */
  }
  applyAccessibilityFromPrefs();
}

/** The user's currently-saved accessibility toggles. */
export function getUserAccessibility(): AccessibilityOverride {
  return readUserA11y();
}

// --- After-paint policy application --------------------------------------------

/**
 * Run just after first paint: apply accessibility prefs, then fetch the managed
 * appearance policy (managed installs only) and apply the ADVISORY org default if
 * the user has not chosen a skin. Never blocks boot; degrades silently when there
 * is no policy / not running under Tauri.
 */
export async function applyAppearancePolicyAfterPaint(): Promise<void> {
  applyAccessibilityFromPrefs();

  let policy: EffectiveAppearancePolicy | null = null;
  try {
    policy = await invoke<EffectiveAppearancePolicy>("get_effective_appearance_policy");
  } catch {
    return; // unmanaged, command absent, or not Tauri
  }
  lastPolicy = policy;
  if (!policy || !policy.managed) return;

  // Make the org skin selectable + applicable, and cache it for next boot.
  if (policy.skin) registerSkin(policy.skin);
  writeManagedCache({
    defaultSkinId: policy.defaultSkinId,
    skin: policy.skin ?? undefined,
    managedBy: policy.managedBy,
  });

  // Advisory: apply the org default ONLY if the user has not made a choice.
  if (
    !hasUserChosenSkin() &&
    policy.defaultSkinId &&
    getSkin(policy.defaultSkinId) &&
    getActiveSkinId() !== policy.defaultSkinId
  ) {
    setActiveSkin(policy.defaultSkinId, { persist: false });
  }
}

/** The last fetched managed policy, for the provenance banner. Null if unmanaged. */
export function getManagedAppearanceInfo(): EffectiveAppearancePolicy | null {
  return lastPolicy;
}

/**
 * Manual "check for updates": ask the host to re-pull the org skin from the
 * registry, then register/cache/apply it (advisory — only auto-applies if the
 * user hasn't chosen a skin). Returns the refreshed policy, or null if unmanaged
 * / not running under Tauri. Used by the Appearance panel's refresh button.
 */
export async function refreshManagedAppearance(): Promise<EffectiveAppearancePolicy | null> {
  let policy: EffectiveAppearancePolicy | null = null;
  try {
    policy = await invoke<EffectiveAppearancePolicy>("refresh_managed_appearance");
  } catch {
    return null;
  }
  lastPolicy = policy;
  if (!policy || !policy.managed) return policy;

  if (policy.skin) registerSkin(policy.skin);
  writeManagedCache({
    defaultSkinId: policy.defaultSkinId,
    skin: policy.skin ?? undefined,
    managedBy: policy.managedBy,
  });
  if (
    !hasUserChosenSkin() &&
    policy.defaultSkinId &&
    getSkin(policy.defaultSkinId) &&
    getActiveSkinId() !== policy.defaultSkinId
  ) {
    setActiveSkin(policy.defaultSkinId, { persist: false });
  }
  return policy;
}
