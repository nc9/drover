import { test, expect } from "bun:test";
import { add, multiply, average } from "./calculator.ts";

test("add", () => {
  expect(add(2, 3)).toBe(5);
  expect(add(-1, 1)).toBe(0);
});

test("multiply", () => {
  expect(multiply(2, 3)).toBe(6);
});

test("average", () => {
  expect(average([2, 4, 6])).toBe(4);
});
