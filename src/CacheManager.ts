/**
 * CacheManager — unified cache API with driver abstraction.
 */

export interface CacheDriver {
	get<T = unknown>(key: string): Promise<T | null>;
	set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
	delete(key: string): Promise<boolean>;
	flush(): Promise<void>;
	has(key: string): Promise<boolean>;
}

interface TaggableDriver extends CacheDriver {
	setWithTags(
		key: string,
		value: unknown,
		tags: string[],
		ttlSeconds?: number,
	): Promise<void>;
	flushTags(tags: string[]): Promise<void>;
}

function isTaggableDriver(driver: CacheDriver): driver is TaggableDriver {
	const candidate = driver as Partial<TaggableDriver>;
	return (
		typeof candidate.flushTags === "function" &&
		typeof candidate.setWithTags === "function"
	);
}

export interface CacheConfig {
	driver?: string;
	prefix?: string;
	ttl?: number;
}

export class CacheManager implements CacheDriver {
	private driver: CacheDriver;
	private prefix: string;
	private defaultTtl: number;

	constructor(driver: CacheDriver, config?: CacheConfig) {
		this.driver = driver;
		this.prefix = config?.prefix ?? "";
		this.defaultTtl = config?.ttl ?? 3600;
	}

	private prefixKey(key: string): string {
		return this.prefix ? `${this.prefix}:${key}` : key;
	}

	async get<T = unknown>(key: string): Promise<T | null> {
		return this.driver.get<T>(this.prefixKey(key));
	}

	async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
		if (value === null || value === undefined) {
			throw new TypeError(
				"Echo: caching null/undefined values is not supported",
			);
		}
		return this.driver.set(
			this.prefixKey(key),
			value,
			ttlSeconds ?? this.defaultTtl,
		);
	}

	async delete(key: string): Promise<boolean> {
		return this.driver.delete(this.prefixKey(key));
	}

	async flush(): Promise<void> {
		return this.driver.flush();
	}

	async has(key: string): Promise<boolean> {
		return this.driver.has(this.prefixKey(key));
	}

	/** Set a value with tags for grouped invalidation. */
	async setWithTags(
		key: string,
		value: unknown,
		tags: string[],
		ttlSeconds?: number,
	): Promise<void> {
		if (value === null || value === undefined) {
			throw new TypeError(
				"Echo: caching null/undefined values is not supported",
			);
		}
		if (!isTaggableDriver(this.driver)) {
			throw new Error(
				"Echo: the configured driver does not support tag-based invalidation",
			);
		}
		return this.driver.setWithTags(
			this.prefixKey(key),
			value,
			tags,
			ttlSeconds ?? this.defaultTtl,
		);
	}

	/** Flush only entries with matching tags. */
	async flushTags(tags: string[]): Promise<void> {
		if (isTaggableDriver(this.driver)) {
			return this.driver.flushTags(tags);
		}
		throw new Error(
			"Echo: the configured driver does not support tag-based invalidation",
		);
	}

	/** In-flight promises for stampede prevention. Each factory is typed per-call; the map is keyed by prefixed cache key. */
	private inflight: Map<string, Promise<unknown>> = new Map();

	/** Get or set — fetch from cache, or compute and store. Single-flight: concurrent misses share one factory call. */
	async remember<T>(
		key: string,
		ttl: number,
		factory: () => Promise<T>,
	): Promise<T> {
		const prefixed = this.prefixKey(key);

		const existing = this.inflight.get(prefixed);
		if (existing) return existing.then((v) => v as T);

		const cached = await this.get<T>(key);
		if (cached !== null) return cached;

		const existingAfterAwait = this.inflight.get(prefixed);
		if (existingAfterAwait) return existingAfterAwait.then((v) => v as T);

		const promise: Promise<T> = factory()
			.then(async (value) => {
				await this.set(key, value, ttl);
				this.inflight.delete(prefixed);
				return value;
			})
			.catch((err) => {
				this.inflight.delete(prefixed);
				throw err;
			});

		this.inflight.set(prefixed, promise);
		return promise;
	}
}
