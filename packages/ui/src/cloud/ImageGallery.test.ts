import { expect, it } from "vitest";
import { imagePath } from "./ImageGallery.js";

it("uses only scoped first-party paths, never model supplied URLs", () => {
  const image = { id: 1, eventId: 2, kind: "highlight" as const, title: "photo" };
  expect(imagePath(image, "a".repeat(64))).toBe(`/api/agent-apps/saishi/workbench/images/${"a".repeat(64)}/2/highlight/1`);
  expect(imagePath(image, "../account")).toBeNull();
  expect(imagePath({ ...image, id: Infinity }, "a".repeat(64))).toBeNull();
});
