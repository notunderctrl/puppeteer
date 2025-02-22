/**
 * Copyright 2022 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {ChildProcess} from 'child_process';

import * as Bidi from 'chromium-bidi/lib/cjs/protocol/protocol.js';

import {
  Browser as BrowserBase,
  BrowserCloseCallback,
  BrowserContextEmittedEvents,
  BrowserContextOptions,
  BrowserEmittedEvents,
} from '../../api/Browser.js';
import {BrowserContext as BrowserContextBase} from '../../api/BrowserContext.js';
import {Page} from '../../api/Page.js';
import {Target} from '../../api/Target.js';
import {Handler} from '../EventEmitter.js';
import {Viewport} from '../PuppeteerViewport.js';

import {BrowserContext} from './BrowserContext.js';
import {
  BrowsingContext,
  BrowsingContextEmittedEvents,
} from './BrowsingContext.js';
import {Connection} from './Connection.js';
import {BiDiPageTarget, BiDiTarget} from './Target.js';
import {debugError} from './utils.js';

/**
 * @internal
 */
export class Browser extends BrowserBase {
  static readonly subscribeModules: Bidi.Session.SubscriptionRequestEvent[] = [
    'browsingContext',
    'network',
    'log',
  ];
  static readonly subscribeCdpEvents: Bidi.Cdp.EventNames[] = [
    // Coverage
    'cdp.Debugger.scriptParsed',
    'cdp.CSS.styleSheetAdded',
    'cdp.Runtime.executionContextsCleared',
    // Tracing
    'cdp.Tracing.tracingComplete',
    // TODO: subscribe to all CDP events in the future.
    'cdp.Network.requestWillBeSent',
    'cdp.Debugger.scriptParsed',
  ];

  static async create(opts: Options): Promise<Browser> {
    let browserName = '';
    let browserVersion = '';

    // TODO: await until the connection is established.
    try {
      const {result} = await opts.connection.send('session.new', {
        capabilities: {
          alwaysMatch: {
            acceptInsecureCerts: opts.ignoreHTTPSErrors,
          },
        },
      });
      browserName = result.capabilities.browserName ?? '';
      browserVersion = result.capabilities.browserVersion ?? '';
    } catch (err) {
      // Chrome does not support session.new.
      debugError(err);
    }

    await opts.connection.send('session.subscribe', {
      events: browserName.toLocaleLowerCase().includes('firefox')
        ? Browser.subscribeModules
        : [...Browser.subscribeModules, ...Browser.subscribeCdpEvents],
    });

    const browser = new Browser({
      ...opts,
      browserName,
      browserVersion,
    });

    await browser.#getTree();

    return browser;
  }

  #browserName = '';
  #browserVersion = '';
  #process?: ChildProcess;
  #closeCallback?: BrowserCloseCallback;
  #connection: Connection;
  #defaultViewport: Viewport | null;
  #defaultContext: BrowserContext;
  #targets = new Map<string, BiDiTarget>();
  #contexts: BrowserContext[] = [];

  #connectionEventHandlers = new Map<string, Handler<any>>([
    ['browsingContext.contextCreated', this.#onContextCreated.bind(this)],
    ['browsingContext.contextDestroyed', this.#onContextDestroyed.bind(this)],
    ['browsingContext.fragmentNavigated', this.#onContextNavigation.bind(this)],
    ['browsingContext.navigationStarted', this.#onContextNavigation.bind(this)],
  ]) as Map<Bidi.BrowsingContext.EventNames, Handler>;

  constructor(
    opts: Options & {
      browserName: string;
      browserVersion: string;
    }
  ) {
    super();
    this.#process = opts.process;
    this.#closeCallback = opts.closeCallback;
    this.#connection = opts.connection;
    this.#defaultViewport = opts.defaultViewport;
    this.#browserName = opts.browserName;
    this.#browserVersion = opts.browserVersion;

    this.#process?.once('close', () => {
      this.#connection.dispose();
      this.emit(BrowserEmittedEvents.Disconnected);
    });
    this.#defaultContext = new BrowserContext(this, {
      defaultViewport: this.#defaultViewport,
      isDefault: true,
    });
    this.#contexts.push(this.#defaultContext);

    for (const [eventName, handler] of this.#connectionEventHandlers) {
      this.#connection.on(eventName, handler);
    }
  }

  #onContextNavigation(event: Bidi.BrowsingContext.NavigationInfo) {
    const context = this.#connection.getBrowsingContext(event.context);
    context.url = event.url;
    const target = this.#targets.get(event.context);
    if (target) {
      this.emit(BrowserEmittedEvents.TargetChanged, target);
      target
        .browserContext()
        .emit(BrowserContextEmittedEvents.TargetChanged, target);
    }
  }

  #onContextCreated(event: Bidi.BrowsingContext.ContextCreatedEvent['params']) {
    const context = new BrowsingContext(this.#connection, event);
    this.#connection.registerBrowsingContexts(context);
    // TODO: once more browsing context types are supported, this should be
    // updated to support those. Currently, all top-level contexts are treated
    // as pages.
    const browserContext = this.browserContexts().at(-1);
    if (!browserContext) {
      throw new Error('Missing browser contexts');
    }
    const target = !context.parent
      ? new BiDiPageTarget(browserContext, context)
      : new BiDiTarget(browserContext, context);
    this.#targets.set(event.context, target);

    this.emit(BrowserEmittedEvents.TargetCreated, target);
    target
      .browserContext()
      .emit(BrowserContextEmittedEvents.TargetCreated, target);

    if (context.parent) {
      const topLevel = this.#connection.getTopLevelContext(context.parent);
      topLevel.emit(BrowsingContextEmittedEvents.Created, context);
    }
  }

  async #getTree(): Promise<void> {
    const {result} = await this.#connection.send('browsingContext.getTree', {});
    for (const context of result.contexts) {
      this.#onContextCreated(context);
    }
  }

  async #onContextDestroyed(
    event: Bidi.BrowsingContext.ContextDestroyedEvent['params']
  ) {
    const context = this.#connection.getBrowsingContext(event.context);
    const topLevelContext = this.#connection.getTopLevelContext(event.context);
    topLevelContext.emit(BrowsingContextEmittedEvents.Destroyed, context);
    const target = this.#targets.get(event.context);
    const page = await target?.page();
    await page?.close().catch(debugError);
    this.#targets.delete(event.context);
    if (target) {
      this.emit(BrowserEmittedEvents.TargetDestroyed, target);
      target
        .browserContext()
        .emit(BrowserContextEmittedEvents.TargetDestroyed, target);
    }
  }

  get connection(): Connection {
    return this.#connection;
  }

  override wsEndpoint(): string {
    return this.#connection.url;
  }

  override async close(): Promise<void> {
    for (const [eventName, handler] of this.#connectionEventHandlers) {
      this.#connection.off(eventName, handler);
    }
    if (this.#connection.closed) {
      return;
    }
    // TODO: implement browser.close.
    // await this.#connection.send('browser.close', {});
    this.#connection.dispose();
    await this.#closeCallback?.call(null);
  }

  override isConnected(): boolean {
    return !this.#connection.closed;
  }

  override process(): ChildProcess | null {
    return this.#process ?? null;
  }

  override async createIncognitoBrowserContext(
    _options?: BrowserContextOptions
  ): Promise<BrowserContextBase> {
    // TODO: implement incognito context https://github.com/w3c/webdriver-bidi/issues/289.
    const context = new BrowserContext(this, {
      defaultViewport: this.#defaultViewport,
      isDefault: false,
    });
    this.#contexts.push(context);
    return context;
  }

  override async version(): Promise<string> {
    return `${this.#browserName}/${this.#browserVersion}`;
  }

  /**
   * Returns an array of all open browser contexts. In a newly created browser, this will
   * return a single instance of {@link BrowserContext}.
   */
  override browserContexts(): BrowserContext[] {
    // TODO: implement incognito context https://github.com/w3c/webdriver-bidi/issues/289.
    return this.#contexts;
  }

  async _closeContext(browserContext: BrowserContext): Promise<void> {
    this.#contexts = this.#contexts.filter(c => {
      return c !== browserContext;
    });
    for (const target of browserContext.targets()) {
      const page = await target?.page();
      await page?.close().catch(error => {
        debugError(error);
      });
    }
  }

  /**
   * Returns the default browser context. The default browser context cannot be closed.
   */
  override defaultBrowserContext(): BrowserContext {
    return this.#defaultContext;
  }

  override newPage(): Promise<Page> {
    return this.#defaultContext.newPage();
  }

  override targets(): Target[] {
    return Array.from(this.#targets.values());
  }

  _getTargetById(id: string): BiDiTarget {
    const target = this.#targets.get(id);
    if (!target) {
      throw new Error('Target not found');
    }
    return target;
  }
}

interface Options {
  process?: ChildProcess;
  closeCallback?: BrowserCloseCallback;
  connection: Connection;
  defaultViewport: Viewport | null;
  ignoreHTTPSErrors?: boolean;
}
