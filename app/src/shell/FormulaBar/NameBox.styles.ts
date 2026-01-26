import styled from 'styled-components';

const v = (name: string) => `var(${name})`;

interface StyledNameBoxInputProps {
  isEditing: boolean;
}

export const StyledNameBoxInput = styled.input<StyledNameBoxInputProps>`
  width: 80px;
  height: 22px;
  border: 1px solid ${v('--namebox-border')};
  border-radius: 0;
  padding: 0 4px;
  font-size: 12px;
  font-family: system-ui, -apple-system, sans-serif;
  outline: none;
  background-color: ${props => props.isEditing ? v('--namebox-bg-editing') : v('--namebox-bg')};
  color: ${v('--namebox-text')};
  caret-color: ${v('--namebox-text')};
  -webkit-text-fill-color: ${v('--namebox-text')};
  text-align: left;
`;