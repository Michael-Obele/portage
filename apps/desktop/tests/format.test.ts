/**
 * `format.ts` is the app's only number renderer, so these assertions ARE the
 * copy rules from `design.md`: units are never dropped and a number is never
 * rounded to a lie.
 *
 * Deliberately imports nothing that needs a Svelte compiler.
 */
import { describe, expect, test } from "bun:test";

import {
	DASH,
	etaWords,
	formatBytes,
	formatDuration,
	formatPercent,
	formatRate,
	plural,
	truncateFront,
	truncateMiddle,
} from "../src/lib/util/format.ts";

describe("formatBytes", () => {
	test("renders zero as bytes, not as an empty unit", () => {
		expect(formatBytes(0)).toBe("0 B");
	});

	test("renders under a kilobyte as a whole number of bytes", () => {
		expect(formatBytes(1)).toBe("1 B");
		expect(formatBytes(1023)).toBe("1023 B");
	});

	test("crosses into KB at exactly 1024", () => {
		expect(formatBytes(1024)).toBe("1.0 KB");
	});

	test("renders one mebibyte as 1.0 MB", () => {
		expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
	});

	test("renders 8.1 GB with one decimal", () => {
		expect(formatBytes(8.1 * 1024 ** 3)).toBe("8.1 GB");
	});

	test("drops the decimal above 100 units, so the string does not grow", () => {
		expect(formatBytes(150 * 1024 * 1024)).toBe("150 MB");
	});

	test("never invents a number for an impossible one", () => {
		expect(formatBytes(-1)).toBe(DASH);
		expect(formatBytes(Number.NaN)).toBe(DASH);
		expect(formatBytes(Number.POSITIVE_INFINITY)).toBe(DASH);
	});
});

describe("formatRate", () => {
	test("renders MB/s with one decimal", () => {
		expect(formatRate(36_400_000)).toBe("36.4 MB/s");
	});

	test("reports a slow link in KB/s rather than 0.0 MB/s", () => {
		expect(formatRate(64_000)).toBe("64.0 KB/s");
	});

	test("shows the dash until there is a measurement", () => {
		expect(formatRate(null)).toBe(DASH);
		expect(formatRate(0)).toBe(DASH);
	});
});

describe("formatDuration and the ETA", () => {
	test("renders seconds under a minute in seconds", () => {
		expect(formatDuration(0)).toBe("0 s");
		expect(formatDuration(45)).toBe("45 s");
	});

	test("renders minutes and seconds in words", () => {
		expect(formatDuration(222)).toBe("3 min 42 s");
		expect(formatDuration(60)).toBe("1 min");
	});

	test("renders hours without pretending they are minutes", () => {
		expect(formatDuration(3840)).toBe("1 h 4 min");
		expect(formatDuration(3730)).toBe("1 h 2 min 10 s");
	});

	test("says the ETA is unknown when it is unknown", () => {
		expect(etaWords(null)).toBe("ETA —");
		expect(formatDuration(null)).toBe(DASH);
	});

	test("gives the ETA as a duration once the engine has one", () => {
		expect(etaWords(222)).toBe("ETA 3 min 42 s");
	});
});

describe("truncateMiddle", () => {
	const name = "Some.Very.Long.Release.Name.Here.1080p.WEB-DL.mkv";

	test("leaves a name that already fits alone", () => {
		expect(truncateMiddle("ep01.mkv", 30)).toBe("ep01.mkv");
	});

	test("keeps the extension when it truncates", () => {
		const result = truncateMiddle(name, 30);
		expect(result).toHaveLength(30);
		expect(result.endsWith(".mkv")).toBe(true);
		expect(result).toContain("…");
	});

	test("keeps the extension of a dotfile-ish short tail too", () => {
		expect(truncateMiddle("A.Very.Long.Release.Name.2026.mkv", 20).endsWith(".mkv")).toBe(true);
	});

	test("does not treat a dotless name as having an extension", () => {
		const result = truncateMiddle("a".repeat(60), 20);
		expect(result).toHaveLength(20);
		expect(result.endsWith("…")).toBe(false);
	});
});

describe("truncateFront", () => {
	test("keeps the filename and drops the far end of the path", () => {
		const path = "/sdcard/Download/Anime/Show/Season 01/episode-01.mkv";
		const result = truncateFront(path, 24);
		expect(result).toHaveLength(24);
		expect(result.startsWith("…")).toBe(true);
		expect(result.endsWith("episode-01.mkv")).toBe(true);
	});

	test("leaves a short path alone", () => {
		expect(truncateFront("/a/b.mkv", 24)).toBe("/a/b.mkv");
	});
});

describe("formatPercent and plural", () => {
	test("renders a fraction as a whole percent", () => {
		expect(formatPercent(0)).toBe("0%");
		expect(formatPercent(0.5)).toBe("50%");
		expect(formatPercent(1)).toBe("100%");
	});

	test("clamps rather than printing 140%", () => {
		expect(formatPercent(1.4)).toBe("100%");
		expect(formatPercent(-1)).toBe("0%");
	});

	test("pluralises only the singular count", () => {
		expect(plural(1, "file")).toBe("1 file");
		expect(plural(0, "file")).toBe("0 files");
		expect(plural(23, "file")).toBe("23 files");
	});
});
