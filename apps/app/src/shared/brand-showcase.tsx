import mindlinkSeal from '../../themes/assets/mindlink-seal.png';

export function BrandShowcase({ variant, name = 'Yuanpu Agent' }: { variant: 'yuanpu' | 'mindlink'; name?: string }) {
  return variant === 'yuanpu'
    ? <div className="brand-showcase brand-showcase-yuanpu" aria-label={`${name} 品牌`}>
      <span className="brand-showcase-mark" aria-hidden="true">
        <svg viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="8" cy="8" r="2.5" /><circle cx="20" cy="8" r="2.5" /><circle cx="14" cy="20" r="2.5" />
          <path d="m10.2 9.5 2.5 7.7m5.1-7.7-2.5 7.7M10.5 8h7" />
        </svg>
      </span>
      <span className="brand-showcase-name">{name}</span>
    </div>
    : <div className="brand-showcase brand-showcase-mindlink" aria-label="元朴思联 MindLink 品牌">
      <span className="brand-showcase-name">元朴思联</span>
      <span className="brand-showcase-roman">MindLink</span>
      <img className="brand-showcase-seal" src={mindlinkSeal} alt="" />
    </div>;
}
