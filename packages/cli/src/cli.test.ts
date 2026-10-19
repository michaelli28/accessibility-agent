import { describe, it, expect } from 'vitest'
import type { Command, Option } from 'commander'
import { createProgram } from './cli.js'

describe('CLI', () => {
  it('creates program with audit and flow commands', () => {
    const program = createProgram()

    expect(program.name()).toBe('at-agent')
    expect(program.commands.map((c: Command) => c.name())).toContain('audit')
    expect(program.commands.map((c: Command) => c.name())).toContain('flow')
  })

  it('audit command has required options', () => {
    const program = createProgram()
    const auditCmd = program.commands.find((c: Command) => c.name() === 'audit')

    expect(auditCmd).toBeDefined()
    expect(auditCmd?.options.some((o: Option) => o.long === '--json')).toBe(true)
  })

  it('flow command has required options', () => {
    const program = createProgram()
    const flowCmd = program.commands.find((c: Command) => c.name() === 'flow')

    expect(flowCmd).toBeDefined()
    expect(flowCmd?.options.some((o: Option) => o.long === '--goal')).toBe(true)
    expect(flowCmd?.options.some((o: Option) => o.long === '--json')).toBe(true)
    expect(flowCmd?.options.some((o: Option) => o.long === '--max-steps')).toBe(true)
  })

  it('flow command accepts --headed flag', () => {
    const program = createProgram()
    const flowCommand = program.commands.find((cmd: Command) => cmd.name() === 'flow')

    expect(flowCommand).toBeDefined()
    const headedOption = flowCommand?.options.find((opt: Option) => opt.long === '--headed')
    expect(headedOption).toBeDefined()
  })

  it('gaps command takes a url and --json', () => {
    const program = createProgram()
    const gapsCmd = program.commands.find((c: Command) => c.name() === 'gaps')

    expect(gapsCmd).toBeDefined()
    expect(gapsCmd?.registeredArguments.map((a) => a.name())).toEqual(['url'])
    expect(gapsCmd?.options.some((o: Option) => o.long === '--json')).toBe(true)
  })
})
