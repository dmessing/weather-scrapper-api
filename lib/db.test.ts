import { describe, expect, it } from "vitest";
import { splitStatements } from "./db.js";

describe("splitStatements", () => {
  it("splits on semicolons and trims", () => {
    expect(splitStatements("SELECT 1;\n\nSELECT 2;\n")).toEqual([
      "SELECT 1",
      "SELECT 2",
    ]);
  });

  it("keeps a statement that opens with a comment line", () => {
    const source = "-- a comment\nCREATE TABLE t (id INT);\n";
    expect(splitStatements(source)).toEqual(["CREATE TABLE t (id INT)"]);
  });

  it("does not split on a semicolon inside a comment", () => {
    // The bug that broke 001_init on its first run.
    const source = "-- prose; with a semicolon\nCREATE TABLE t (id INT);\n";
    expect(splitStatements(source)).toEqual(["CREATE TABLE t (id INT)"]);
  });

  it("strips a trailing inline comment", () => {
    expect(splitStatements("SELECT 1; -- trailing note\nSELECT 2;")).toEqual([
      "SELECT 1",
      "SELECT 2",
    ]);
  });

  it("drops comment-only chunks", () => {
    expect(splitStatements("-- just a note\n-- and another\n")).toEqual([]);
  });

  it("returns nothing for empty input", () => {
    expect(splitStatements("")).toEqual([]);
    expect(splitStatements("\n\n  \n")).toEqual([]);
  });
});
