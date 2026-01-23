import React from 'react';
import { defaultTheme } from './defaultTheme';

interface ThemeRootProps {
  children: React.ReactNode;
}

/**
 * Injects the default theme variables into the document root.
 * Later, this component will be replaced by the Extension System's theme loader.
 */
export const ThemeRoot: React.FC<ThemeRootProps> = ({ children }) => {
  // Convert the theme map to a CSS string: "--token: value;"
  const cssVars = Object.entries(defaultTheme)
    .map(([key, value]) => `${key}: ${value};`)
    .join(' ');

  return (
    <>
      <style>
        {`:root { ${cssVars} }`}
      </style>
      {children}
    </>
  );
};