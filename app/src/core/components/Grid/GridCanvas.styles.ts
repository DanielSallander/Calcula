import styled from 'styled-components';

const v = (name: string) => `var(${name})`;

export const GridContainer = styled.div`
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  overflow: hidden;
  z-index: 0;
`;

export const StyledCanvas = styled.canvas`
  display: block;
  position: absolute;
  top: 0;
  left: 0;
`;