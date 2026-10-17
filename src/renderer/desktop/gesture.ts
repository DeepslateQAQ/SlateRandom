export interface GesturePoint { x: number; y: number }
interface PointerCoordinates {
  pointerType: string;
  screenX: number;
  screenY: number;
  clientX: number;
  clientY: number;
}

/**
 * Windows touch can report screenX/Y relative to the moving transparent HWND.
 * Its client point plus the borderless window origin gives stable screen DIPs.
 * Mouse/pen events already carry absolute screen coordinates.
 */
export function resolvePointerPoint(event: PointerCoordinates, origin: { screenX: number; screenY: number }): GesturePoint {
  return event.pointerType === 'touch'
    ? { x: origin.screenX + event.clientX, y: origin.screenY + event.clientY }
    : { x: event.screenX, y: event.screenY };
}

export type GestureRelease = 'click' | 'drag' | 'none';
export const BALL_HOLD_MS = 3000;
export const BALL_DRAG_THRESHOLD = 6;

/** Drag remains a drag even when the pointer returns to its starting point. */
export class BallGesture {
  private origin: GesturePoint | null = null;
  private startedAt = 0;
  private dragged = false;
  private confirmed = false;

  begin(point: GesturePoint, now: number): void {
    this.origin = point;
    this.startedAt = now;
    this.dragged = false;
    this.confirmed = false;
  }

  move(point: GesturePoint): { firstDrag: boolean; dragging: boolean; dx: number; dy: number } {
    if (!this.origin) return { firstDrag: false, dragging: false, dx: 0, dy: 0 };
    const dx = point.x - this.origin.x, dy = point.y - this.origin.y;
    const firstDrag = !this.dragged && Math.hypot(dx, dy) >= BALL_DRAG_THRESHOLD;
    if (firstDrag) this.dragged = true;
    return { firstDrag, dragging: this.dragged, dx, dy };
  }

  confirm(now: number): boolean {
    if (!this.origin || this.dragged || this.confirmed || now - this.startedAt < BALL_HOLD_MS) return false;
    this.confirmed = true;
    return true;
  }

  release(cancelled = false): GestureRelease {
    if (!this.origin) return 'none';
    const result: GestureRelease = cancelled || this.confirmed ? 'none' : this.dragged ? 'drag' : 'click';
    this.origin = null;
    return result;
  }

  get active(): boolean { return this.origin !== null; }
}
import type { DesktopDrag, DesktopDragEnd, DesktopDragReady, DesktopDragStart } from './types';


interface DragTransport {
  start(start: DesktopDragStart): Promise<void | DesktopDragReady>;
  move(position: DesktopDrag): void;
  end(end: DesktopDragEnd): Promise<void>;
}

interface DragSession {
  start: DesktopDragStart;
  position: DesktopDrag;
  rendered: DesktopDrag | null;
  ready: Promise<void | DesktopDragReady>;
  isReady: boolean;
  frame: number | null;
  dirty: boolean;
  closed: boolean;
  nativeEnded: boolean;
  nativeTracking: boolean;
  failureReported: boolean;
}

/** Serializes native starts/ends and sends at most one latest position per frame. */
export class BallDragSession {
  private current: DragSession | null = null;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly transport: DragTransport,
    private readonly requestFrame: (callback: FrameRequestCallback) => number,
    private readonly cancelFrame: (id: number) => void,
    private readonly onError: (reason: unknown, id: string) => void = () => {},
  ) {}

  get id(): string | null { return this.current?.start.id ?? null; }
  get nativeTracking(): boolean { return this.current?.nativeTracking ?? false; }

  start(start: DesktopDragStart, position: DesktopDrag): void {
    if (this.current) void this.end(this.current.start.id, true);
    const session: DragSession = {
      start, position: { ...position, id: start.id }, rendered: null, ready: Promise.resolve(), isReady: false, frame: null,
      dirty: true, closed: false, nativeEnded: false, nativeTracking: false, failureReported: false,
    };
    this.current = session;
    session.ready = this.tail.then(() => this.transport.start(start));
    this.tail = session.ready.catch(() => {});
    void session.ready.then(reply => {
      session.isReady = true;
      session.nativeTracking = Boolean(reply?.nativeTracking);
      if (!session.closed && this.current === session) {
        // Begin touch movement immediately; smoothing only applies to later points.
        if (start.pointerType === 'touch') this.flush(session);
        else this.schedule(session);
      }
    }, reason => {
      session.closed = true;
      if (this.current === session) this.current = null;
      this.report(session, reason);
    });
  }

  move(id: string, position: DesktopDrag): void {
    const session = this.current;
    if (!session || session.start.id !== id || session.closed) return;
    if (!Number.isFinite(position.dx) || !Number.isFinite(position.dy)) return;
    session.position = { ...position, id };
    session.dirty = true;
    // Waiting for readiness avoids flooding IPC while the native start is pending.
    if (session.isReady) this.schedule(session);
  }

  end(id: string, cancelled = false): Promise<void> {
    const session = this.current;
    if (!session || session.start.id !== id) return Promise.resolve();
    this.current = null;
    session.closed = true;
    if (session.frame !== null) this.cancelFrame(session.frame);
    session.frame = null;
    const ending = session.ready.then(async () => {
      if (session.nativeEnded) return;
      // Release must preserve the actual endpoint rather than the filtered tail.
      this.flush(session, true);
      await this.transport.end({ id, cancelled });
    });
    this.tail = ending.catch(reason => { this.report(session, reason); });
    return this.tail.then(() => {});
  }

  /** A native contact tracker can finish independently after capture is lost. */
  endedByNative(id: string): void {
    const session = this.current;
    if (!session || session.start.id !== id) return;
    session.nativeEnded = true;
    session.closed = true;
    if (session.frame !== null) this.cancelFrame(session.frame);
    session.frame = null;
    this.current = null;
  }

  private schedule(session: DragSession): void {
    if (session.frame !== null || !session.dirty) return;
    session.frame = this.requestFrame(() => {
      session.frame = null;
      if (!session.closed && this.current === session) this.flush(session);
    });
  }

  private flush(session: DragSession, exact = false): void {
    if (!session.dirty) return;
    const target = session.position, previous = session.rendered;
    let next = target;
    if (!exact && session.start.pointerType === 'touch' && previous) {
      const dx = target.dx - previous.dx, dy = target.dy - previous.dy;
      // A moving Windows host may deliver its origin and a touch sample a frame
      // apart. One frame of exponential smoothing damps that coordinate noise.
      if (Math.hypot(dx, dy) > 0.25) next = { id: target.id, dx: previous.dx + dx * 0.5, dy: previous.dy + dy * 0.5 };
    }
    session.rendered = next;
    session.dirty = next.dx !== target.dx || next.dy !== target.dy;
    this.transport.move(next);
    if (session.dirty && !session.closed && this.current === session) this.schedule(session);
  }

  private report(session: DragSession, reason: unknown): void {
    if (session.failureReported) return;
    session.failureReported = true;
    this.onError(reason, session.start.id);
  }
}
