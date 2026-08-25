import { useMediaQuery } from "./useMediaQuery";
import { useClientSettings } from "./useSettings";

/**
 * Whether layout surfaces (app sidebar, right panels, terminal drawer) may
 * animate. Opt-in via Settings > Appearance, and always off under the OS
 * reduced-motion preference. Components that wait on a CSS transition to
 * finish (panel exits) must treat false as "settle immediately", matching
 * the `transition: none` kill-switch keyed on `html[data-interface-animations]`.
 */
export function useInterfaceAnimationsEnabled(): boolean {
  const interfaceAnimations = useClientSettings((settings) => settings.interfaceAnimations);
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  return interfaceAnimations && !prefersReducedMotion;
}
