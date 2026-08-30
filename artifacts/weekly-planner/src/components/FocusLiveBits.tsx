import { formatCountdown, getFocusTimerElapsedSeconds, type FocusTimerState } from '@/lib/focusSessions';
import { useLiveClock } from '@/lib/liveClock';

export function FocusLiveCountdown({
  timer,
  hardwareArmSeconds,
}: {
  timer: FocusTimerState;
  hardwareArmSeconds: number;
}) {
  const now = useLiveClock(timer.isRunning && hardwareArmSeconds <= 0);
  if (hardwareArmSeconds > 0) return <>{hardwareArmSeconds}s</>;
  const remaining = Math.max(0, timer.plannedSeconds - getFocusTimerElapsedSeconds(timer, now));
  return <>{formatCountdown(remaining)}</>;
}

export function FocusLiveStartingLabel({
  timer,
  hardwareArmSeconds,
  accentColor,
}: {
  timer: FocusTimerState;
  hardwareArmSeconds: number;
  accentColor?: string;
}) {
  const now = useLiveClock(timer.isRunning && hardwareArmSeconds <= 0);
  if (hardwareArmSeconds > 0) {
    return <span className="text-base font-semibold whitespace-nowrap" style={{ color: accentColor || '#60a5fa' }}>Starting in {hardwareArmSeconds}s</span>;
  }
  const remaining = Math.max(0, timer.plannedSeconds - getFocusTimerElapsedSeconds(timer, now));
  return <>{formatCountdown(remaining)}</>;
}

export function FocusLiveProgress({
  timer,
  runningColor,
  idleColor,
}: {
  timer: FocusTimerState;
  runningColor: string;
  idleColor: string;
}) {
  const now = useLiveClock(timer.isRunning);
  const elapsed = getFocusTimerElapsedSeconds(timer, now);
  const pct = Math.min(100, Math.max(0, (elapsed / timer.plannedSeconds) * 100));
  return (
    <div
      className="h-full rounded-full"
      style={{
        width: `${pct}%`,
        background: timer.isRunning ? runningColor : idleColor,
      }}
    />
  );
}
