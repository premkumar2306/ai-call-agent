import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { NotAvailable } from './ui';

describe('NotAvailable', () => {
  it('uses "isn\'t" for a singular feature', () => {
    render(<NotAvailable feature="Online payment" />);
    expect(screen.getByText("Online payment isn't available yet.")).toBeTruthy();
  });
  it('uses "aren\'t" for a plural feature', () => {
    render(<NotAvailable feature="Hindi and Hinglish calls" plural />);
    expect(screen.getByText("Hindi and Hinglish calls aren't available yet.")).toBeTruthy();
  });
});
