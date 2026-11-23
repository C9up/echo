import { Exception } from "@c9up/flare";
import { describe, expect, it } from "vitest";
import { errors } from "../../src/index.js";

describe("the errors namespace", () => {
	it("is exported from the entry, one flare Exception per code", () => {
		const error = new errors.E_ECHO_UNKNOWN_STORE(['unknown cache store "x"']);
		expect(error).toBeInstanceOf(Exception);
		expect(error).toBeInstanceOf(errors.E_ECHO_UNKNOWN_STORE);
		expect(error.code).toBe("E_ECHO_UNKNOWN_STORE");
		expect(error.status).toBe(500);
		expect(error.message).toBe('Echo: unknown cache store "x"');

		const lock = new errors.E_ECHO_LOCK_TIMEOUT("k", 10);
		expect(lock).toBeInstanceOf(Exception);
		expect(lock).toMatchObject({ code: "E_ECHO_LOCK_TIMEOUT", key: "k" });
	});
});
