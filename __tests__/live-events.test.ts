import { describe, it, expect, beforeEach } from 'vitest';
import { LiveEventBus } from '../src/live-events.js';

describe('LiveEventBus', () => {
  let bus: LiveEventBus;

  beforeEach(() => {
    bus = new LiveEventBus();
  });

  it('reports zero clients when none connected', () => {
    expect(bus.clientCount()).toBe(0);
  });

  it('broadcasts event to subscribed listener', () => {
    const received: string[] = [];
    const unsub = bus.subscribe((event, data) => {
      received.push(`${event}:${JSON.stringify(data)}`);
    });

    bus.emit('stream.thinking', { traceId: 't1', text: 'hello' });

    expect(received).toHaveLength(1);
    expect(received[0]).toContain('stream.thinking');
    expect(received[0]).toContain('hello');

    unsub();
    expect(bus.clientCount()).toBe(0);
  });

  it('does not throw when emitting with no subscribers', () => {
    expect(() => bus.emit('heartbeat', {})).not.toThrow();
  });

  it('removes subscriber on unsub call', () => {
    const unsub = bus.subscribe(() => {});
    expect(bus.clientCount()).toBe(1);
    unsub();
    expect(bus.clientCount()).toBe(0);
  });

  it('handles multiple subscribers', () => {
    const counts = [0, 0];
    const unsub1 = bus.subscribe(() => { counts[0]++; });
    const unsub2 = bus.subscribe(() => { counts[1]++; });

    bus.emit('heartbeat', {});

    expect(counts).toEqual([1, 1]);
    unsub1();
    unsub2();
  });
});
