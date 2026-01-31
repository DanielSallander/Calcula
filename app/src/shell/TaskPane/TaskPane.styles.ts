//! FILENAME: app/src/shell/task-pane/TaskPane.styles.ts
// PURPOSE: Styled components for Task Pane
// CONTEXT: Uses CSS-in-JS via styled-components

import styled from "styled-components";

export const TaskPaneWrapper = styled.div<{
  $width: number;
  $isOpen: boolean;
  $dockMode: "docked" | "floating";
}>`
  /* Always positioned absolute - floats over content */
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  z-index: 100;
  
  display: flex;
  flex-direction: column;
  height: 100%;
  background-color: #f8f9fa;
  border-left: 1px solid #e0e0e0;
  overflow: hidden;
  
  /* Fixed width */
  width: ${({ $width }) => $width}px;
  
  /* Slide animation using transform */
  transform: translateX(${({ $isOpen }) => ($isOpen ? "0" : "100%")});
  transition: transform 0.15s ease-out;
  will-change: transform;
  
  /* Shadow only when open */
  box-shadow: ${({ $isOpen }) => ($isOpen ? "-4px 0 12px rgba(0, 0, 0, 0.1)" : "none")};
  
  /* Prevent interaction when closed */
  pointer-events: ${({ $isOpen }) => ($isOpen ? "auto" : "none")};
`;

export const TaskPaneContent = styled.div<{ $isVisible: boolean }>`
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  opacity: ${({ $isVisible }) => ($isVisible ? 1 : 0)};
  transition: opacity 0.1s ease-out;
  transition-delay: ${({ $isVisible }) => ($isVisible ? "0.05s" : "0s")};
`;

export const ResizeHandle = styled.div`
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 4px;
  cursor: ew-resize;
  background: transparent;
  z-index: 10;

  &:hover,
  &:active {
    background: #0078d4;
  }
`;

export const Header = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 36px;
  padding: 0 8px;
  background: #ffffff;
  border-bottom: 1px solid #e0e0e0;
  flex-shrink: 0;
`;

export const TabStrip = styled.div`
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 1;
  overflow-x: auto;
  overflow-y: hidden;

  /* Hide scrollbar but allow scrolling */
  scrollbar-width: none;
  -ms-overflow-style: none;
  &::-webkit-scrollbar {
    display: none;
  }
`;

export const Tab = styled.button<{ $active: boolean }>`
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: none;
  border-radius: 4px 4px 0 0;
  background: ${({ $active }) => ($active ? "#f8f9fa" : "transparent")};
  color: ${({ $active }) => ($active ? "#333" : "#666")};
  font-size: 12px;
  font-weight: ${({ $active }) => ($active ? 600 : 400)};
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.1s, color 0.1s;

  &:hover {
    background: ${({ $active }) => ($active ? "#f8f9fa" : "#f0f0f0")};
    color: #333;
  }
`;

export const TabIcon = styled.span`
  font-size: 14px;
  display: flex;
  align-items: center;
`;

export const TabCloseButton = styled.button`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  margin-left: 4px;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: #999;
  font-size: 12px;
  cursor: pointer;

  &:hover {
    background: #e0e0e0;
    color: #333;
  }
`;

export const HeaderActions = styled.div`
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: 8px;
`;

export const HeaderButton = styled.button`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: #666;
  font-size: 16px;
  cursor: pointer;

  &:hover {
    background: #e0e0e0;
    color: #333;
  }
`;

export const Content = styled.div`
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
`;

export const EmptyState = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 24px;
  color: #999;
  text-align: center;
  font-size: 13px;
`;

export const EmptyStateIcon = styled.div`
  font-size: 48px;
  margin-bottom: 16px;
  opacity: 0.5;
`;

export const EmptyStateText = styled.p`
  margin: 0 0 8px 0;
`;