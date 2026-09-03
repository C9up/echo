/**
 * Teach ream's `ContainerBindings` what `container.make(...)` returns for the
 * tokens echo binds.
 *
 * ream declares that interface open on purpose: it registers its own entries
 * and expects each package to contribute the ones it owns. Nothing filled
 * these in, so resolving by the string token answered `unknown` and every call
 * site had to assert a type it could not prove.
 *
 * Loaded from the package barrel, so importing Echo anywhere in the
 * application is enough — nobody writes a `declare module` of their own.
 *
 * Type-only, and ream stays an OPTIONAL peer: nothing here reaches a runtime
 * import, and a `declare module` for a specifier that does not resolve is
 * simply inert.
 */

// Referenced so the augmentation below resolves the module it augments.
import type {} from "@c9up/ream/types";

import type { CacheManager } from "./CacheManager.js";

declare module "@c9up/ream/types" {
	interface ContainerBindings {
		/** The cache manager, bound by `EchoProvider`. */
		"echo.cache": CacheManager;
		/**
		 * The same binding under the name it had before the token carried its
		 * package. Kept bound so an existing `container.make(...)` resolves.
		 */
		cache: CacheManager;
	}
}
