import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
import { OpenRouter } from '@openrouter/sdk';
import { jsonrepair } from 'jsonrepair';

dotenv.config();

async function runScript(scriptName: string, url: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const env = { ...process.env, JSON_OUTPUT_PATH: outputPath, DOTENV_QUIET: 'true' };
        // Use shell: true for npm compatibility on some systems
        // Add '-s' to npm run to suppress the command echo
        const proc = spawn('npm', ['run', '-s', scriptName, '--', url], { stdio: 'inherit', env, shell: true });
        
        proc.on('close', (code) => {
            if (code === 0) resolve();
            else {
                // Don't reject immediately on non-zero, just warn, so other scripts can finish?
                // But if a script fails, we might miss data.
                // Let's resolve but log error, so we can aggregate whatever we have.
                console.warn(`Script ${scriptName} exited with code ${code}`);
                resolve(); 
            }
        });
        
        proc.on('error', (err) => {
            console.error(`Failed to start ${scriptName}:`, err);
            resolve();
        });
    });
}

async function main() {
    // Dynamic imports for ESM
    const chalk = (await import('chalk')).default;
    const ora = (await import('ora')).default;
    const boxen = (await import('boxen')).default;

    const url = process.argv[2];
    if (!url) {
        console.error(chalk.red('Usage: npm run audit <url>'));
        process.exit(1);
    }

    const tempDir = path.join(process.cwd(), 'temp_audit_results');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

    const results = {
        dom: path.join(tempDir, 'dom.json'),
        visual: path.join(tempDir, 'visual.json'),
        regression: path.join(tempDir, 'regression.json'),
        media: path.join(tempDir, 'media.json')
    };

    console.log(boxen(chalk.bold(`Starting Comprehensive WCAG Audit\nTarget: ${chalk.cyan(url)}`), { 
        borderStyle: 'double', 
        padding: 1, 
        margin: 1,
        borderColor: 'magenta',
        float: 'center'
    }));

    // 1. DOM Analysis
    console.log(chalk.bold.blue('\n🔹 Stage 1: DOM Semantic Analysis\n'));
    await runScript('audit-dom', url, results.dom);

    // 2. Visual Analysis
    console.log(chalk.bold.blue('\n🔹 Stage 2: Visual & Contrast Analysis\n'));
    await runScript('audit-visual', url, results.visual);

    // 3. Visual Regression (Responsiveness)
    console.log(chalk.bold.blue('\n🔹 Stage 3: Responsiveness & Reflow Analysis\n'));
    await runScript('audit-visual-regression', url, results.regression);

    // 4. Media Analysis
    console.log(chalk.bold.blue('\n🔹 Stage 4: Media & Caption Analysis\n'));
    await runScript('audit-media', url, results.media);

    // 5. Aggregation
    console.log(chalk.bold.magenta('\n✨ Final Stage: Generating Comprehensive Report\n'));
    const spinner = ora('Aggregating all findings...').start();

    try {
        const aggregatedData: any = {};

        if (fs.existsSync(results.dom)) {
            try { aggregatedData.dom = JSON.parse(fs.readFileSync(results.dom, 'utf-8')); } catch(e) {}
        }
        if (fs.existsSync(results.visual)) {
            try { aggregatedData.visual = JSON.parse(fs.readFileSync(results.visual, 'utf-8')); } catch(e) {}
        }
        if (fs.existsSync(results.regression)) {
             try { aggregatedData.regression = JSON.parse(fs.readFileSync(results.regression, 'utf-8')); } catch(e) {}
        }
        if (fs.existsSync(results.media)) {
             try { aggregatedData.media = JSON.parse(fs.readFileSync(results.media, 'utf-8')); } catch(e) {}
        }

        const apiKey = process.env.OPENROUTER_API_KEY;
        if (!apiKey) {
            spinner.fail('OPENROUTER_API_KEY not set');
            return;
        }

        const openRouter = new OpenRouter({ 
            apiKey,
            defaultHeaders: {
                'HTTP-Referer': 'http://localhost:3000',
                'X-Title': 'AT Agent Audit',
            },
        });
        
        const systemPromptPath = path.join(__dirname, 'prompts', 'wcag_final.txt');
        const systemPrompt = fs.readFileSync(systemPromptPath, 'utf-8');

        const completion = await openRouter.chat.send({
            model: process.env.AGGREGATOR_MODEL || 'openai/gpt-5.1',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: JSON.stringify(aggregatedData) }
            ],
            reasoning: { effort: 'high' }
        });

        spinner.stop();

        if (completion?.choices?.[0]?.message?.content) {
             const content = completion.choices[0].message.content;
             const report = JSON.parse(jsonrepair(content));
             
             // Pretty print the final report
             console.log(boxen(chalk.bold('Final WCAG Compliance Report'), { padding: 1, margin: 1, borderStyle: 'double', borderColor: 'green' }));
             
             let scoreColor = chalk.green;
             if (report.score < 80) scoreColor = chalk.yellow;
             if (report.score < 50) scoreColor = chalk.red;

             console.log(chalk.bold(`Overall Score: `) + scoreColor(`${report.score}/100`));
             console.log(chalk.italic(report.summary));
             console.log('\n');

             if (report.categories) {
                 report.categories.forEach((cat: any) => {
                     console.log(chalk.bold.underline(cat.name));
                     if (cat.violations && cat.violations.length > 0) {
                        cat.violations.forEach((v: any) => {
                            const sevColor = v.severity === 'Critical' ? chalk.red : v.severity === 'Major' ? chalk.yellow : chalk.white;
                            console.log(sevColor(`[${v.severity}] ${v.description}`));
                            if (v.location) console.log(chalk.gray(`   📍 ${v.location}`));
                            if (v.recommendation) console.log(chalk.blue(`   💡 ${v.recommendation}`));
                            if (v.wcag_sc) console.log(chalk.gray(`   📜 ${v.wcag_sc}`));
                            console.log('');
                        });
                     } else {
                         console.log(chalk.green('   ✅ No violations found.'));
                         console.log('');
                     }
                 });
             }

             // Save final report
             const reportFileName = `audit_report_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
             const finalPath = path.join(process.cwd(), reportFileName);
             fs.writeFileSync(finalPath, JSON.stringify(report, null, 2));
             console.log(chalk.green(`\n📄 Full JSON report saved to: ${finalPath}`));

        } else {
            console.error(chalk.red("No content received from aggregation model."));
        }

    } catch (e) {
        spinner.fail('Aggregation failed');
        console.error(e);
    } finally {
        // Cleanup temp dir
        try {
            if (fs.existsSync(tempDir)) {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        } catch (e) {}
    }
}

main();
