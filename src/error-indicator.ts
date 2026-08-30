export type VisualIndicator = 'warning' | 'error' | null;

export function nextIndicator(
  current: VisualIndicator,
  event: AvatarBridgeEvent,
): VisualIndicator {
  return event.type === 'indicator'
    ? event.indicator === 'clear'
      ? null
      : event.indicator
    : current;
}
