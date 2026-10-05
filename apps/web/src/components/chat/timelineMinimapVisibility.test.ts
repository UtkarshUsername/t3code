import { it, expect } from "vite-plus/test";
import {
  isTimelineMinimapRowVisible,
  resolveTimelineMinimapCurrentIndex,
} from "./MessagesTimeline.logic";

it("highlights only the visible cluster while preserving adjacent markers", () => {
  const rowIndices = [0, 10, 20, 30, 40, 50];
  expect(rowIndices.filter((index) => isTimelineMinimapRowVisible(index, 19, 31))).toEqual([
    20, 30,
  ]);
  expect(isTimelineMinimapRowVisible(20, null, null)).toBe(false);
  expect(isTimelineMinimapRowVisible(20, 20, 20)).toBe(true);
});

it("resolves minimap navigation from the visible rows", () => {
  const rowIndices = [0, 10, 20, 30, 40];
  const resolve = (visibleStart: number | null, visibleEnd: number | null) =>
    resolveTimelineMinimapCurrentIndex({ visibleStart, visibleEnd, rowIndices });

  // Only the actual visible cluster participates, regardless of cached positions.
  expect(resolve(19, 31)).toBe(2);
  expect(resolve(21, 29)).toBe(2);
  expect(resolve(41, 45)).toBe(4);
  expect(resolve(0, 0)).toBe(0);
  expect(resolve(null, null)).toBeNull();
  expect(
    resolveTimelineMinimapCurrentIndex({ visibleStart: 0, visibleEnd: 5, rowIndices: [] }),
  ).toBeNull();
});
