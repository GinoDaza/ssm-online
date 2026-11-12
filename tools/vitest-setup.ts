/**
 * Each test starts on a new turn of the event loop. The emulator tests run synchronously, and
 * awaits alone never let the worker read vitest's replies: a file of them over 60 s (the
 * worker's RPC deadline) ends in "Timeout calling onTaskUpdate" although every test passes.
 */
import { beforeEach } from 'vitest';

beforeEach(() => new Promise<void>((resolve) => setImmediate(resolve)));
