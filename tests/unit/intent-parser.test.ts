import { describe, expect, it } from 'vitest';
import { parseIntent } from '../../src/gateway/intent-parser.js';

describe('parseIntent', () => {
  it('should_parse_help_command', () => {
    expect(parseIntent('/help').type).toBe('help');
  });

  it('should_parse_approve_command', () => {
    expect(parseIntent('/approve').type).toBe('approve');
  });

  it('should_treat_natural_language_as_create_task', () => {
    const intent = parseIntent('给 trade 模块加日期筛选');
    expect(intent.type).toBe('create_task');
  });
});
