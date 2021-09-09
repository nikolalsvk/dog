import * as HEADERS from './internal/headers';
import * as ROUTES from './internal/routes';
import * as utils from './internal/utils';

import type { ReqID, ShardID } from './shard';
import type * as DOG from 'dog';

// NOTE: Private
type LiveCount = number;
type BucketTuple = [ShardID, LiveCount];

export abstract class Gateway<T extends ModuleWorker.Bindings> implements DOG.Gateway<T> {
	public abstract limit: number;
	public readonly uid: string;

	readonly #mapping: Map<ReqID, ShardID>;
	readonly #child: DurableObjectNamespace;
	readonly #kids: Map<ShardID, LiveCount>;

	#sorted: ShardID[];
	#current?: ShardID;

	constructor(state: DurableObjectState, env: T) {
		this.uid = state.id.toString();
		this.#mapping = new Map;
		this.#kids = new Map;
		this.#sorted = [];

		let refs = this.link(env);
		this.#child = refs.child;
	}

	/**
	 * Specify which `Shard` class extension is the target.
	 * @NOTE User-supplied logic/function.
	 */
	abstract link(bindings: T): {
		child: DurableObjectNamespace & DOG.Shard<T>;
		self: DurableObjectNamespace & DOG.Gateway<T>;
	};

	/**
	 * Generate a unique identifier for the request.
	 * @NOTE User-supplied logic/function.
	 */
	abstract identify(req: Request): Promise<ReqID> | ReqID;

	/**
	 * Generate a `DurableObjectId` for the shard cluster
	 */
	clusterize(req: Request, target: DurableObjectNamespace): Promise<DurableObjectId> | DurableObjectId {
		return target.newUniqueId();
	}

	/**
	 * Receive the request & figure out where to send it.
	 */
	async fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
		let request = new Request(input, init);
		let { pathname } = new URL(request.url, 'foo://');

		// ~> internal SHARD request
		if (pathname === ROUTES.CLOSE) {
			try {
				return await this.#close(request);
			} catch (err) {
				return utils.abort(400, (err as Error).message);
			}
		}

		let rid = await this.identify(request);

		let alive: number | void;
		let sid = this.#mapping.get(rid) || this.#current || this.#sorted[0];
		if (sid != null) alive = this.#kids.get(sid);

		if (alive != null && this.limit >= ++alive) {
			// use this shard if found & not over limit
		} else {
			// if aware of existing shards, sort & get most free
			// NOTE: `sync` only keeps buckets if `alive` <= limit
			let pair = this.#sorted.length > 0 && await this.#sort();

			if (pair) {
				sid = pair[0];
				alive = pair[1] + 1;
			} else {
				sid = await this.clusterize(request, this.#child).toString();
				this.#welcome(sid); // no await!
				alive = 1;
			}
		}

		this.#current = (alive < this.limit) ? sid : undefined;

		this.#mapping.set(rid, sid);
		this.#kids.set(sid, alive);

		// Attach indentifiers / hash keys
		request.headers.set(HEADERS.GATEWAYID, this.uid);
		request.headers.set(HEADERS.CLIENTID, rid);
		request.headers.set(HEADERS.SHARDID, sid);

		return utils.load(this.#child, sid).fetch(request);
	}

	/**
	 * Notify existing SHARDs of a new neighbor.
	 * @param {ShardID} nid  The newly created SHARD identifier.
	 */
	async #welcome(nid: ShardID): Promise<void> {
		// get read-only copy
		let items = [...this.#kids.keys()];
		this.#sorted.unshift(nid);
		this.#kids.set(nid, 1);

		if (items.length > 0) {
			await Promise.all(
				items.map(sid => Promise.all([
					this.#introduce(nid, sid),
					this.#introduce(sid, nid),
				]))
			);
		}
	}

	/**
	 * Introduce `stranger` to the existing `target` shard.
	 */
	#introduce(stranger: ShardID, target: ShardID): Promise<Response> {
		let headers = new Headers;
		headers.set(HEADERS.SHARDID, target);
		headers.set(HEADERS.NEIGHBORID, stranger);
		headers.set(HEADERS.GATEWAYID, this.uid);

		let stub = utils.load(this.#child, target);
		return stub.fetch(ROUTES.NEIGHBOR, { headers });
	}

	/**
	 * Sort all "sid:" entries by most available.
	 * Save the sorted list as `this.sorted` property.
	 * Return the most-available entry.
	 */
	async #sort(): Promise<BucketTuple | void> {
		let tuples: BucketTuple[] = [ ...this.#kids ];

		if (tuples.length > 1) {
			tuples.sort((a, b) => a[1] - b[1]);
		}

		let i=0, list: ShardID[] = [];
		let bucket: BucketTuple | void;
		for (; i < tuples.length; i++) {
			// ignore buckets w/ active >= limit
			if (tuples[i][1] < this.limit) {
				if (!bucket) bucket = tuples[i];
				list.push(tuples[i][0]); // keep shard id
			}
		}

		this.#sorted = list;

		return bucket;
	}

	async #close(req: Request): Promise<Response> {
		var { rid, sid, gid } = utils.validate(req);
		if (gid !== this.uid) throw new Error('Mismatch: Gateway ID');

		let alive = this.#kids.get(sid);
		if (alive == null) throw new Error('Unknown: Shard ID');

		alive = Math.max(0, --alive);
		this.#kids.set(sid, alive);

		if (req.headers.get(HEADERS.ISEMPTY) === '1') {
			this.#mapping.delete(rid);
		}

		// sort by availability
		let bucket = await this.#sort();
		this.#current = bucket ? bucket[0] : undefined;

		return new Response('OK');
	}
}
