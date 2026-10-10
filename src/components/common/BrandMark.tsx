import React from 'react';

interface BrandMarkProps {
  name?: string;
  className?: string;
}

export const BrandMark: React.FC<BrandMarkProps> = ({ name = 'ANDA C SMOKE HUB', className = '' }) => {
  return (
    <span className={`brand-seal clay-surface grid aspect-square shrink-0 place-items-center rounded-[28%] border p-[3px] ${className}`}>
      <img
        src="/brand-mark.png"
        alt={`${name} logo`}
        className="h-full w-full rounded-[22%] object-contain"
      />
    </span>
  );
};