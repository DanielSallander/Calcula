//! FILENAME: app/src/core/state/GridContext.tsx
// PURPOSE: React Context provider for grid state management.
// CONTEXT: This module creates a React Context that provides the grid state and dispatch
// function to all child components. It uses useReducer for predictable state updates
// and enables components to access grid state without prop drilling.

import React, { createContext, useReducer, useContext } from "react";
import type { ReactNode } from "react";
import type { GridState } from "../types";
import type { GridAction } from "./gridActions";
import { gridReducer, getInitialState } from "./gridReducer";
import { setGridDispatchRef } from "../../api/gridDispatch";

/**
 * Context value interface combining state and dispatch.
 */
interface GridContextValue {
  state: GridState;
  dispatch: React.Dispatch<GridAction>;
}

/**
 * The Grid Context - provides state and dispatch to consumers.
 */
const GridContext = createContext<GridContextValue | null>(null);

/**
 * Props for the GridProvider component.
 */
interface GridProviderProps {
  children: ReactNode;
  initialState?: GridState;
}

/**
 * GridProvider component - wraps the application to provide grid state.
 * 
 * @param children - Child components that will have access to the context
 * @param initialState - Optional initial state override for testing
 */
// Module-level state ref for non-React access (e.g., extensions)
let gridStateRef: GridState | null = null;

/** Get the current grid state snapshot (for use outside React components). */
export function getGridStateSnapshot(): GridState | null {
  return gridStateRef;
}

export function GridProvider({ children, initialState }: GridProviderProps): React.ReactElement {
  const [state, dispatch] = useReducer(gridReducer, initialState || getInitialState());

  // Expose dispatch globally so non-React code (extensions) can dispatch actions
  setGridDispatchRef(dispatch);

  // Keep state ref up to date for non-React consumers
  gridStateRef = state;

  const value: GridContextValue = {
    state,
    dispatch,
  };

  return (
    <GridContext.Provider value={value}>
      {children}
    </GridContext.Provider>
  );
}

/**
 * Hook to access the grid context.
 * Must be used within a GridProvider.
 * 
 * @returns The grid context value containing state and dispatch
 * @throws Error if used outside of GridProvider
 */
export function useGridContext(): GridContextValue {
  const context = useContext(GridContext);

  if (!context) {
    throw new Error("useGridContext must be used within a GridProvider");
  }

  return context;
}

/**
 * Hook to access only the grid state (for components that only read state).
 * 
 * @returns The current grid state
 */
export function useGridState(): GridState {
  const { state } = useGridContext();
  return state;
}

/**
 * Hook to access only the dispatch function (for components that only dispatch).
 * 
 * @returns The dispatch function
 */
export function useGridDispatch(): React.Dispatch<GridAction> {
  const { dispatch } = useGridContext();
  return dispatch;
}