#!/usr/bin/env node
// @at-agent/cli - Accessibility testing command-line interface
import 'dotenv/config'
import { createProgram } from './cli.js'

const program = createProgram()
program.parse(process.argv)
