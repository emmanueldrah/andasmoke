import React from 'react';

interface BrandMarkProps {
  name?: string;
  className?: string;
}

export const BrandMark: React.FC<BrandMarkProps> = ({ name = 'ANDA C SMOKE HUB', className = '' }) => {
  return (
    <img
      src="/brand-mark.png"
      alt={`${name} logo`}
      className={`aspect-square shrink-0 object-contain ${className}`}
    />
  );
};
