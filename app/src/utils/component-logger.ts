// FILENAME: src/utils/component-logger.ts
// PURPOSE: Comprehensive React component logging with minimal integration overhead
// Provides HOCs, hooks, and decorators for automatic call graph tracing

import React, { useEffect, useRef, useCallback, useMemo } from 'react';
import { logger } from './logger';

// ============================================================================
// CONFIGURATION
// ============================================================================

interface LogConfig {
  enabled: boolean;
  logLifecycle: boolean;
  logHooks: boolean;
  logEvents: boolean;
  logFunctions: boolean;
  logState: boolean;
  logRenders: boolean;
  // Throttle render logs to avoid spam (ms)
  renderThrottleMs: number;
}

const DEFAULT_CONFIG: LogConfig = {
  enabled: import.meta.env.DEV,
  logLifecycle: true,
  logHooks: true,
  logEvents: true,
  logFunctions: true,
  logState: true,
  logRenders: false, // Off by default - very noisy
  renderThrottleMs: 100,
};

let config: LogConfig = { ...DEFAULT_CONFIG };

export function configureComponentLogger(overrides: Partial<LogConfig>): void {
  config = { ...config, ...overrides };
}

export function enableComponentLogger(): void {
  config.enabled = true;
}

export function disableComponentLogger(): void {
  config.enabled = false;
}

// ============================================================================
// CATEGORIES
// ============================================================================

// Log categories for call graph parsing
export const CAT = {
  COMP: 'COMP',      // Component lifecycle
  HOOK: 'HOOK',      // Hook execution
  EVENT: 'EVENT',    // User events (keyboard, focus, etc.)
  ACTION: 'ACTION',  // State actions/dispatches
  STATE: 'STATE',    // State changes
  CMD: 'CMD',          // Function calls
  RENDER: 'RENDER',  // Render cycles
  EFFECT: 'EFFECT',  // useEffect executions
} as const;

type Category = typeof CAT[keyof typeof CAT];

// ============================================================================
// CORE LOGGING HELPERS
// ============================================================================

function logComponent(action: string, name: string, details?: string): void {
  if (!config.enabled || !config.logLifecycle) return;
  const msg = details ? `${action} ${name} ${details}` : `${action} ${name}`;
  logger.info(CAT.COMP, msg);
}

function logHook(hookName: string, componentName: string, details?: string): void {
  if (!config.enabled || !config.logHooks) return;
  const msg = details 
    ? `${hookName} in ${componentName} ${details}` 
    : `${hookName} in ${componentName}`;
  logger.debug(CAT.HOOK, msg);
}

function logEffect(componentName: string, effectName: string, action: 'RUN' | 'CLEANUP'): void {
  if (!config.enabled || !config.logHooks) return;
  logger.debug(CAT.EFFECT, `${action} ${componentName}.${effectName}`);
}

function logEvent(eventType: string, componentName: string, details?: string): void {
  if (!config.enabled || !config.logEvents) return;
  const msg = details 
    ? `${eventType} ${componentName} ${details}` 
    : `${eventType} ${componentName}`;
  logger.info(CAT.EVENT, msg);
}

function logFn(fnName: string, action: 'ENTER' | 'EXIT', details?: string): void {
  if (!config.enabled || !config.logFunctions) return;
  const msg = details ? `${action} ${fnName} ${details}` : `${action} ${fnName}`;
  logger.debug(CAT.CMD, msg);
}

function logAction(actionName: string, details?: string): void {
  if (!config.enabled || !config.logState) return;
  const msg = details ? `${actionName} ${details}` : actionName;
  logger.info(CAT.ACTION, msg);
}

function logState(storeName: string, change: string): void {
  if (!config.enabled || !config.logState) return;
  logger.debug(CAT.STATE, `${storeName} ${change}`);
}

function logRender(componentName: string, reason?: string): void {
  if (!config.enabled || !config.logRenders) return;
  const msg = reason ? `${componentName} reason=${reason}` : componentName;
  logger.debug(CAT.RENDER, msg);
}

// ============================================================================
// HIGHER-ORDER COMPONENT FOR LIFECYCLE LOGGING
// ============================================================================

interface WithLoggingOptions {
  name?: string;
  logRenders?: boolean;
  logProps?: boolean;
}

/**
 * HOC that wraps a component with automatic lifecycle logging.
 * 
 * Usage:
 *   const MyComponent = withLogging(MyComponentBase, { name: 'MyComponent' });
 *   // or
 *   export default withLogging(function MyComponent() { ... });
 */
export function withLogging<P extends object>(
  WrappedComponent: React.ComponentType<P>,
  options: WithLoggingOptions = {}
): React.FC<P> {
  const displayName = options.name || WrappedComponent.displayName || WrappedComponent.name || 'Unknown';
  const shouldLogRenders = options.logRenders ?? config.logRenders;

  const WithLogging: React.FC<P> = (props) => {
    const mountedRef = useRef(false);
    const renderCountRef = useRef(0);
    const lastRenderTimeRef = useRef(0);

    // Mount/Unmount logging
    useEffect(() => {
      logComponent('MOUNT', displayName);
      mountedRef.current = true;

      return () => {
        logComponent('UNMOUNT', displayName);
      };
    }, []);

    // Render logging (throttled)
    if (shouldLogRenders && mountedRef.current) {
      const now = Date.now();
      if (now - lastRenderTimeRef.current > config.renderThrottleMs) {
        renderCountRef.current++;
        logRender(displayName, `count=${renderCountRef.current}`);
        lastRenderTimeRef.current = now;
      }
    }

    // Log props if requested (debug only)
    if (options.logProps && config.enabled) {
      const propsStr = Object.keys(props as object).join(',');
      logComponent('PROPS', displayName, `keys=[${propsStr}]`);
    }

    return React.createElement(WrappedComponent, props);
  };

  WithLogging.displayName = `withLogging(${displayName})`;
  return WithLogging;
}

// ============================================================================
// LOGGED HOOKS
// ============================================================================

/**
 * useEffect with automatic logging of execution and cleanup.
 * 
 * Usage:
 *   useLoggedEffect('MyComponent', 'fetchData', () => {
 *     fetchData();
 *     return () => cleanup();
 *   }, [deps]);
 */
export function useLoggedEffect(
  componentName: string,
  effectName: string,
  effect: React.EffectCallback,
  deps?: React.DependencyList
): void {
  useEffect(() => {
    logEffect(componentName, effectName, 'RUN');
    const cleanup = effect();
    return () => {
      logEffect(componentName, effectName, 'CLEANUP');
      if (cleanup) cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/**
 * useCallback with automatic logging when the callback is invoked.
 * 
 * Usage:
 *   const handleClick = useLoggedCallback('Grid', 'handleClick', (e) => {
 *     // handler code
 *   }, [deps]);
 */
export function useLoggedCallback<T extends (...args: unknown[]) => unknown>(
  componentName: string,
  callbackName: string,
  callback: T,
  deps: React.DependencyList
): T {
  return useCallback((...args: Parameters<T>) => {
    logFn(`${componentName}.${callbackName}`, 'ENTER');
    const result = callback(...args);
    // Handle promises
    if (result instanceof Promise) {
      return result.finally(() => {
        logFn(`${componentName}.${callbackName}`, 'EXIT');
      }) as ReturnType<T>;
    }
    logFn(`${componentName}.${callbackName}`, 'EXIT');
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps) as T;
}

/**
 * useMemo with logging when the value is recomputed.
 * 
 * Usage:
 *   const computed = useLoggedMemo('Grid', 'visibleCells', () => {
 *     return computeVisibleCells();
 *   }, [deps]);
 */
export function useLoggedMemo<T>(
  componentName: string,
  memoName: string,
  factory: () => T,
  deps: React.DependencyList
): T {
  return useMemo(() => {
    logHook(`useMemo:${memoName}`, componentName, 'RECOMPUTE');
    return factory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/**
 * Hook for logging component mount with a simple one-liner.
 * 
 * Usage (add to any component):
 *   useComponentLogger('GridCanvas');
 */
export function useComponentLogger(componentName: string): void {
  const mountedRef = useRef(false);

  useEffect(() => {
    if (!mountedRef.current) {
      logComponent('MOUNT', componentName);
      mountedRef.current = true;
    }
    return () => {
      logComponent('UNMOUNT', componentName);
    };
  }, [componentName]);
}

// ============================================================================
// EVENT LOGGING HELPERS
// ============================================================================

type EventHandler<E extends Event = Event> = (event: E) => void;

/**
 * Wrap an event handler with logging.
 * 
 * Usage:
 *   <div onClick={loggedHandler('Grid', 'onClick', handleClick)} />
 */
export function loggedHandler<E extends Event>(
  componentName: string,
  handlerName: string,
  handler: EventHandler<E>,
  extractDetails?: (event: E) => string
): EventHandler<E> {
  return (event: E) => {
    const details = extractDetails ? extractDetails(event) : undefined;
    logEvent(handlerName, componentName, details);
    handler(event);
  };
}

/**
 * Create a keyboard event logger with key details.
 * 
 * Usage:
 *   <div onKeyDown={loggedKeyHandler('Grid', 'onKeyDown', handleKeyDown)} />
 */
export function loggedKeyHandler(
  componentName: string,
  handlerName: string,
  handler: (event: React.KeyboardEvent) => void
): (event: React.KeyboardEvent) => void {
  return (event: React.KeyboardEvent) => {
    const mods: string[] = [];
    if (event.ctrlKey) mods.push('Ctrl');
    if (event.shiftKey) mods.push('Shift');
    if (event.altKey) mods.push('Alt');
    if (event.metaKey) mods.push('Meta');
    const modStr = mods.length > 0 ? mods.join('+') + '+' : '';
    logEvent(handlerName, componentName, `key=${modStr}${event.key}`);
    handler(event);
  };
}

/**
 * Create a mouse event logger with position details.
 * 
 * Usage:
 *   <canvas onMouseDown={loggedMouseHandler('Grid', 'onMouseDown', handleMouseDown)} />
 */
export function loggedMouseHandler(
  componentName: string,
  handlerName: string,
  handler: (event: React.MouseEvent) => void,
  includePosition = false
): (event: React.MouseEvent) => void {
  return (event: React.MouseEvent) => {
    let details = `button=${event.button}`;
    if (includePosition) {
      details += ` x=${event.clientX} y=${event.clientY}`;
    }
    logEvent(handlerName, componentName, details);
    handler(event);
  };
}

// ============================================================================
// FUNCTION TRACING DECORATOR
// ============================================================================

/**
 * Wrap a function with entry/exit logging.
 * 
 * Usage:
 *   const tracedFn = traced('calculateLayout', originalFn);
 *   // or for class methods:
 *   this.handleClick = traced('Grid.handleClick', this.handleClick.bind(this));
 */
export function traced<T extends (...args: unknown[]) => unknown>(
  fnName: string,
  fn: T,
  extractArgs?: (...args: Parameters<T>) => string
): T {
  return ((...args: Parameters<T>) => {
    const argDetails = extractArgs ? extractArgs(...args) : undefined;
    logFn(fnName, 'ENTER', argDetails);
    
    try {
      const result = fn(...args);
      
      // Handle async functions
      if (result instanceof Promise) {
        return result
          .then((val) => {
            logFn(fnName, 'EXIT');
            return val;
          })
          .catch((err) => {
            logFn(fnName, 'EXIT', `error=${err?.message || 'unknown'}`);
            throw err;
          }) as ReturnType<T>;
      }
      
      logFn(fnName, 'EXIT');
      return result;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'unknown';
      logFn(fnName, 'EXIT', `error=${errMsg}`);
      throw err;
    }
  }) as T;
}

/**
 * Create multiple traced functions from an object of functions.
 * 
 * Usage:
 *   const handlers = traceAll('Grid', {
 *     handleClick: (e) => { ... },
 *     handleKeyDown: (e) => { ... },
 *   });
 */
export function traceAll<T extends Record<string, (...args: unknown[]) => unknown>>(
  prefix: string,
  fns: T
): T {
  const result = {} as T;
  for (const [name, fn] of Object.entries(fns)) {
    result[name as keyof T] = traced(`${prefix}.${name}`, fn) as T[keyof T];
  }
  return result;
}

// ============================================================================
// ZUSTAND MIDDLEWARE FOR STATE LOGGING
// ============================================================================

type StateCreator<T> = (
  set: (partial: Partial<T> | ((state: T) => Partial<T>)) => void,
  get: () => T,
  api: unknown
) => T;

/**
 * Zustand middleware that logs all state actions.
 * 
 * Usage:
 *   const useStore = create(
 *     withStateLogging('GridStore', (set, get) => ({
 *       // store definition
 *     }))
 *   );
 */
export function withStateLogging<T extends object>(
  storeName: string,
  creator: StateCreator<T>
): StateCreator<T> {
  return (set, get, api) => {
    const loggedSet = (partial: Partial<T> | ((state: T) => Partial<T>)) => {
      const prevState = get();
      
      // Determine what changed
      let changes: Partial<T>;
      if (typeof partial === 'function') {
        changes = partial(prevState);
      } else {
        changes = partial;
      }
      
      // Log the action
      const changedKeys = Object.keys(changes);
      logAction(`${storeName}.setState`, `keys=[${changedKeys.join(',')}]`);
      
      // Log individual state changes at debug level
      for (const key of changedKeys) {
        const oldVal = prevState[key as keyof T];
        const newVal = changes[key as keyof T];
        if (oldVal !== newVal) {
          logState(storeName, `${key}: ${summarizeValue(oldVal)} --> ${summarizeValue(newVal)}`);
        }
      }
      
      set(partial);
    };
    
    return creator(loggedSet, get, api);
  };
}

/**
 * Summarize a value for logging (truncate long values).
 */
function summarizeValue(val: unknown): string {
  if (val === null) return 'null';
  if (val === undefined) return 'undefined';
  if (typeof val === 'boolean' || typeof val === 'number') return String(val);
  if (typeof val === 'string') {
    return val.length > 30 ? `"${val.slice(0, 30)}..."` : `"${val}"`;
  }
  if (Array.isArray(val)) {
    return `Array(${val.length})`;
  }
  if (typeof val === 'object') {
    const keys = Object.keys(val);
    return `{${keys.slice(0, 3).join(',')}${keys.length > 3 ? ',...' : ''}}`;
  }
  return typeof val;
}

// ============================================================================
// ACTION CREATOR WRAPPER
// ============================================================================

/**
 * Wrap store actions to log when they're called.
 * 
 * Usage:
 *   // In your store:
 *   const actions = loggedActions('GridStore', {
 *     setSelection: (selection) => set({ selection }),
 *     clearSelection: () => set({ selection: null }),
 *   });
 */
export function loggedActions<T extends Record<string, (...args: unknown[]) => unknown>>(
  storeName: string,
  actions: T
): T {
  const logged = {} as T;
  
  for (const [name, action] of Object.entries(actions)) {
    logged[name as keyof T] = ((...args: unknown[]) => {
      // Summarize args
      const argSummary = args.length > 0 
        ? args.map(summarizeValue).join(', ')
        : '';
      logAction(`${storeName}.${name}`, argSummary ? `(${argSummary})` : '');
      return action(...args);
    }) as T[keyof T];
  }
  
  return logged;
}

// ============================================================================
// MANUAL LOGGING API (for cases where decorators don't fit)
// ============================================================================

export const componentLog = {
  mount: (name: string) => logComponent('MOUNT', name),
  unmount: (name: string) => logComponent('UNMOUNT', name),
  render: (name: string, reason?: string) => logRender(name, reason),
  update: (name: string, what: string) => logComponent('UPDATE', name, what),
};

export const hookLog = {
  effect: (component: string, name: string, action: 'RUN' | 'CLEANUP') => 
    logEffect(component, name, action),
  memo: (component: string, name: string) => 
    logHook(`useMemo:${name}`, component, 'RECOMPUTE'),
  callback: (component: string, name: string) => 
    logHook(`useCallback:${name}`, component, 'RECREATE'),
  state: (component: string, name: string, value: unknown) =>
    logHook(`useState:${name}`, component, `=${summarizeValue(value)}`),
};

export const eventLog = {
  keyboard: (component: string, handler: string, key: string, mods?: string[]) => {
    const modStr = mods && mods.length > 0 ? mods.join('+') + '+' : '';
    logEvent(handler, component, `key=${modStr}${key}`);
  },
  mouse: (component: string, handler: string, button: number, x?: number, y?: number) => {
    let details = `button=${button}`;
    if (x !== undefined && y !== undefined) details += ` x=${x} y=${y}`;
    logEvent(handler, component, details);
  },
  focus: (component: string, handler: string, target?: string) =>
    logEvent(handler, component, target ? `target=${target}` : undefined),
  custom: (component: string, handler: string, details?: string) =>
    logEvent(handler, component, details),
};

export const fnLog = {
  enter: (name: string, args?: string) => logFn(name, 'ENTER', args),
  exit: (name: string, result?: string) => logFn(name, 'EXIT', result),
  call: (name: string, details?: string) => {
    logFn(name, 'ENTER', details);
    logFn(name, 'EXIT');
  },
};

export const stateLog = {
  action: (store: string, action: string, args?: string) => 
    logAction(`${store}.${action}`, args),
  change: (store: string, field: string, from: unknown, to: unknown) =>
    logState(store, `${field}: ${summarizeValue(from)} --> ${summarizeValue(to)}`),
};

// ============================================================================
// EXPORTS
// ============================================================================

export {
  logComponent,
  logHook,
  logEffect,
  logEvent,
  logFn,
  logAction,
  logState,
  logRender,
};