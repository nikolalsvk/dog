import type { Gateway, Shard } from 'dog';

// TODO: Remove the intersection types?
export interface Bindings extends ModuleWorker.Bindings {
	LOBBY: DurableObjectNamespace & Gateway<Bindings>;
	ROOM: DurableObjectNamespace & Shard<Bindings>;
}