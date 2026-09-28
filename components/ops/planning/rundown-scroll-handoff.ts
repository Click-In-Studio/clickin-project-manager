/**
 * Rundown 纵向滚动的边界交接状态机。
 *
 * 第一次同向手势到边界时由内层消耗；手势结束后保留边界武装状态，
 * 下一次同向手势交给浏览器原生的外层滚动链。反向或离开边界会解除武装。
 */

export type ScrollBoundary = "top" | "bottom";
export type ScrollDirection = "up" | "down";
export type ScrollHandoffAction = "inner" | "stop" | "outer";

export type ScrollHandoffState = {
  armedBoundary: ScrollBoundary | null;
  gestureAction: ScrollHandoffAction | null;
  gestureDirection: ScrollDirection | null;
};

export type ScrollMetrics = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

const EDGE_EPSILON = 1;
const WHEEL_GESTURE_IDLE_MS = 140;

export function initialScrollHandoffState(): ScrollHandoffState {
  return { armedBoundary: null, gestureAction: null, gestureDirection: null };
}

export function beginScrollGesture(state: ScrollHandoffState): ScrollHandoffState {
  return { ...state, gestureAction: null, gestureDirection: null };
}

export function endScrollGesture(state: ScrollHandoffState): ScrollHandoffState {
  return { ...state, gestureAction: null, gestureDirection: null };
}

function maxScrollTop(metrics: ScrollMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight);
}

export function syncScrollBoundary(
  state: ScrollHandoffState,
  metrics: ScrollMetrics,
): ScrollHandoffState {
  if (state.armedBoundary === "top" && metrics.scrollTop > EDGE_EPSILON) {
    return initialScrollHandoffState();
  }
  if (
    state.armedBoundary === "bottom"
    && metrics.scrollTop < maxScrollTop(metrics) - EDGE_EPSILON
  ) {
    return initialScrollHandoffState();
  }
  return state;
}

export function advanceScrollHandoff(
  state: ScrollHandoffState,
  direction: ScrollDirection,
  distance: number,
  metrics: ScrollMetrics,
): { state: ScrollHandoffState; action: ScrollHandoffAction; boundary: ScrollBoundary | null } {
  // 短表没有内部纵向滚动可交接，不能凭“同时位于上下边界”吞掉页面的首次手势。
  if (maxScrollTop(metrics) <= EDGE_EPSILON) {
    return { state: initialScrollHandoffState(), action: "outer", boundary: null };
  }

  const boundary: ScrollBoundary = direction === "up" ? "top" : "bottom";
  const reversed = state.gestureDirection !== null && state.gestureDirection !== direction;
  const current = reversed ? initialScrollHandoffState() : syncScrollBoundary(state, metrics);

  if (!reversed && current.gestureDirection === direction && current.gestureAction === "stop") {
    return { state: current, action: "stop", boundary };
  }
  if (!reversed && current.gestureDirection === direction && current.gestureAction === "outer") {
    return { state: current, action: "outer", boundary };
  }

  const remaining = direction === "up"
    ? Math.max(0, metrics.scrollTop)
    : Math.max(0, maxScrollTop(metrics) - metrics.scrollTop);
  const reachesBoundary = remaining <= Math.max(0, distance) + EDGE_EPSILON;

  if (!reachesBoundary) {
    return {
      state: { armedBoundary: null, gestureAction: "inner", gestureDirection: direction },
      action: "inner",
      boundary: null,
    };
  }

  const action: ScrollHandoffAction = current.armedBoundary === boundary ? "outer" : "stop";
  return {
    state: { armedBoundary: boundary, gestureAction: action, gestureDirection: direction },
    action,
    boundary,
  };
}

function readMetrics(element: HTMLElement): ScrollMetrics {
  return {
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  };
}

function wheelDistance(event: WheelEvent, element: HTMLElement): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return Math.abs(event.deltaY) * 16;
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return Math.abs(event.deltaY) * element.clientHeight;
  return Math.abs(event.deltaY);
}

export function installRundownScrollHandoff(element: HTMLElement): () => void {
  let state = initialScrollHandoffState();
  let wheelGestureActive = false;
  let wheelEndTimer: ReturnType<typeof setTimeout> | null = null;
  let touchPoint: { x: number; y: number } | null = null;

  const stopAtBoundary = (boundary: ScrollBoundary) => {
    element.scrollTop = boundary === "top" ? 0 : maxScrollTop(readMetrics(element));
  };

  const onWheel = (event: WheelEvent) => {
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX) || event.deltaY === 0) return;
    if (!wheelGestureActive) {
      wheelGestureActive = true;
      state = beginScrollGesture(state);
    }

    const direction: ScrollDirection = event.deltaY < 0 ? "up" : "down";
    const result = advanceScrollHandoff(state, direction, wheelDistance(event, element), readMetrics(element));
    state = result.state;
    if (result.action === "stop" && result.boundary) {
      event.preventDefault();
      stopAtBoundary(result.boundary);
    }

    if (wheelEndTimer) clearTimeout(wheelEndTimer);
    wheelEndTimer = setTimeout(() => {
      state = endScrollGesture(state);
      wheelGestureActive = false;
      wheelEndTimer = null;
    }, WHEEL_GESTURE_IDLE_MS);
  };

  const onTouchStart = (event: TouchEvent) => {
    if (event.touches.length !== 1) {
      touchPoint = null;
      return;
    }
    const touch = event.touches[0];
    touchPoint = { x: touch.clientX, y: touch.clientY };
    state = beginScrollGesture(state);
  };

  const onTouchMove = (event: TouchEvent) => {
    if (!touchPoint || event.touches.length !== 1) return;
    const touch = event.touches[0];
    const deltaX = touchPoint.x - touch.clientX;
    const deltaY = touchPoint.y - touch.clientY;
    touchPoint = { x: touch.clientX, y: touch.clientY };
    if (Math.abs(deltaY) <= Math.abs(deltaX) || deltaY === 0) return;

    const direction: ScrollDirection = deltaY < 0 ? "up" : "down";
    const result = advanceScrollHandoff(state, direction, Math.abs(deltaY), readMetrics(element));
    state = result.state;
    if (result.action === "stop" && result.boundary) {
      if (event.cancelable) event.preventDefault();
      stopAtBoundary(result.boundary);
    }
  };

  const onTouchEnd = () => {
    touchPoint = null;
    state = endScrollGesture(state);
  };

  const onScroll = () => {
    state = syncScrollBoundary(state, readMetrics(element));
  };

  element.addEventListener("wheel", onWheel, { passive: false });
  element.addEventListener("touchstart", onTouchStart, { passive: true });
  element.addEventListener("touchmove", onTouchMove, { passive: false });
  element.addEventListener("touchend", onTouchEnd, { passive: true });
  element.addEventListener("touchcancel", onTouchEnd, { passive: true });
  element.addEventListener("scroll", onScroll, { passive: true });

  return () => {
    if (wheelEndTimer) clearTimeout(wheelEndTimer);
    element.removeEventListener("wheel", onWheel);
    element.removeEventListener("touchstart", onTouchStart);
    element.removeEventListener("touchmove", onTouchMove);
    element.removeEventListener("touchend", onTouchEnd);
    element.removeEventListener("touchcancel", onTouchEnd);
    element.removeEventListener("scroll", onScroll);
  };
}
