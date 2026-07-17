import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import App from './App';

test('renders dashboard layout seamlessly without structural failures', () => {
  render(<App />);
  // Verifies the core programmatic anchor is present on mount
  const headingElement = screen.getByText(/Your match/i);
  expect(headingElement).toBeInTheDocument();
});
