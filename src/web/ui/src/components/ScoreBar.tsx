interface ScoreBreakdown {
  vectorScore: number;
  keywordScore: number;
  rawVectorScore: number;
  rawKeywordScore: number;
  keywordWeight: number;
  vectorRank?: number;
  keywordRank?: number;
}

interface ScoreBarProps {
  explanation: {
    scoreBreakdown: ScoreBreakdown;
    matchedTerms?: string[];
  };
}

export function ScoreBar({ explanation }: ScoreBarProps) {
  const { vectorScore, keywordScore, rawVectorScore, rawKeywordScore, keywordWeight, vectorRank, keywordRank } =
    explanation.scoreBreakdown;
  const total = Math.max(vectorScore + keywordScore, 0.001);
  const vPct = ((vectorScore / total) * 100).toFixed(0);
  const kPct = ((keywordScore / total) * 100).toFixed(0);

  return (
    <div className="mb-2">
      <div className="flex items-center gap-2 text-xs mb-1">
        <span className="text-cyan-400" title={`Vector: ${rawVectorScore.toFixed(3)}${vectorRank !== undefined ? `, rank #${vectorRank + 1}` : ""}`}>
          Vector {vPct}%
        </span>
        <span className="text-amber-400" title={`Keyword: ${rawKeywordScore.toFixed(3)}${keywordRank !== undefined ? `, rank #${keywordRank + 1}` : ""}`}>
          Keyword {kPct}%
        </span>
        <span className="text-slate-500 ml-auto">kw={keywordWeight.toFixed(1)}</span>
      </div>
      <div className="h-2 bg-slate-700 rounded-full overflow-hidden flex">
        <div
          className="h-full bg-cyan-500 transition-all duration-200"
          style={{ width: `${vPct}%` }}
        />
        <div
          className="h-full bg-amber-500 transition-all duration-200"
          style={{ width: `${kPct}%` }}
        />
      </div>
    </div>
  );
}
