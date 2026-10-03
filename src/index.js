import { LauncherLink, LinkError } from './transport.js';
import { ChatBridge } from './chat.js';
export { LauncherLink, LinkError };
export const name = 'launcher-link';
export const inject = [];
export const provide = ['launcherLink'];

/** Cordis owns both the exposed service and its outbound socket lifetime. */
export function apply(ctx, config = {}) {
  const link = new LauncherLink(config);
  ctx.provide('launcherLink', link);
  if (config.chat !== false) ctx.inject(['sessionController'], chatCtx => {
    chatCtx.effect(() => {
      const bridge = new ChatBridge(chatCtx, link);
      return () => bridge.dispose();
    });
  });
  ctx.effect(() => {
    const onState = status => {
      if (ctx.get('logger')) ctx.logger('launcher-link').info(`connection ${status.state} (${status.instanceId || 'unconfigured'})`);
    };
    link.on('state', onState);
    link.start();
    return () => { link.off('state', onState); link.stop(); };
  });
}
