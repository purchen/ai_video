import React from 'react';
import type { SourceRecord } from '../../src/domain/schemas';

export function SourceCard({ sources }: { sources: SourceRecord[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {sources.map((source) => (
        <article
          key={source.id}
          style={{
            background: '#172e39',
            borderLeft: '7px solid #65d6ba',
            borderRadius: 12,
            padding: 34,
          }}
        >
          <div style={{ fontSize: 27, color: '#65d6ba', marginBottom: 18 }}>
            来源依据
          </div>
          <div
            style={{ fontSize: 40, lineHeight: 1.4, overflowWrap: 'anywhere' }}
          >
            {source.title}
          </div>
          <div
            style={{
              fontSize: 29,
              color: '#b8cbd0',
              marginTop: 24,
              lineHeight: 1.5,
            }}
          >
            {source.publisher}
            <br />
            {source.publishedAt
              ? `发布 ${source.publishedAt.slice(0, 10)}`
              : `采集 ${source.capturedAt.slice(0, 10)}（发布日期未提供）`}
          </div>
        </article>
      ))}
    </div>
  );
}
