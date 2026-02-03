import React from "react";
import * as S from "./RibbonButton.styles";

export interface RibbonButtonProps {
  /** Button label */
  label: string;
  /** Icon to display (React element) */
  icon?: React.ReactNode;
  /** Click handler */
  onClick?: () => void;
  /** Whether button is disabled */
  disabled?: boolean;
  /** Whether button is in "active" state */
  active?: boolean;
  /** Tooltip text */
  title?: string;
  /** Button size */
  size?: "small" | "medium" | "large";
}

export function RibbonButton({
  label,
  icon,
  onClick,
  disabled = false,
  active = false,
  title,
  size = "medium",
}: RibbonButtonProps): React.ReactElement {
  return (
    <S.StyledButton
      onClick={onClick}
      disabled={disabled}
      title={title}
      $active={active}
      $size={size}
    >
      {icon && <S.IconWrapper>{icon}</S.IconWrapper>}
      <span>{label}</span>
    </S.StyledButton>
  );
}