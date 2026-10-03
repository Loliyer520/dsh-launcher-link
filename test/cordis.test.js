import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { createMockLauncher } from '../examples/mock-launcher.mjs';
import * as plugin from '../src/index.js';

// Set this to the host runtime's cordis/lib/index.js file URL to run the host smoke test.
test('host Cordis provides the service and disposes its socket on plugin unload', {
  skip: !process.env.DSH_CORDIS_MODULE,
}, async t => {
  const { Context } = await import(process.env.DSH_CORDIS_MODULE);
  const launcher = await createMockLauncher({ token: 'cordis-lifecycle-test-only-token' });
  const ctx = new Context();
  const fiber = await ctx.plugin(plugin, { url: launcher.url, token: 'cordis-lifecycle-test-only-token', instanceId: 'cordis-test' });
  t.after(async () => { await fiber.dispose(); await ctx.fiber.dispose(); await launcher.close(); });
  const link = ctx.launcherLink;
  if (link.state !== 'ready') await once(link, 'ready', { signal: AbortSignal.timeout(3000) });
  assert.equal(launcher.instances.size, 1);
  assert.equal(link.info().instanceId, 'cordis-test');
  const closed = once(launcher.instances.get('cordis-test').socket, 'close');
  await fiber.dispose();
  await closed;
  assert.equal(link.state, 'stopped');
  assert.equal(ctx.get('launcherLink'), undefined);
  await sleep(50);
  assert.equal(launcher.instances.size, 0);
});
