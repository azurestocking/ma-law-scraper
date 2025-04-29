const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://malegislature.gov/Laws/GeneralLaws';
const OUTPUT_FILE = 'massachusetts_general_laws.json';

// Helper function to delay execution
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper functions to parse the text
function parsePartText(text) {
    const match = text.match(/Part\s+([IVX]+)\s+(.*?)\s+Chapters\.\s+(\d+-\d+)/);
    if (match) {
        return {
            part: match[1],
            part_title: match[2].trim()
        };
    }
    return null;
}

function parseTitleText(text) {
    const match = text.match(/Title\s+([IVX]+)\s+(.*)/);
    if (match) {
        return {
            title: match[1],
            title_name: match[2].trim()
        };
    }
    return null;
}

function parseChapterText(text) {
    const match = text.match(/Chapter\s+([\dA-Z]+)\s+(.*)/);
    if (match) {
        return {
            chapter: match[1],
            chapter_title: match[2].trim()
        };
    }
    return null;
}

async function getParts(page) {
    console.log('Getting parts...');
    await page.goto(BASE_URL);
    await page.waitForSelector('.generalLawsList');
    await delay(2000); // Wait for any animations to complete

    const parts = await page.evaluate(() => {
        const partElements = document.querySelectorAll('.generalLawsList > li > a');
        return Array.from(partElements).map(element => ({
            part: element.textContent.trim(),
            part_title: element.getAttribute('title'),
            url: element.href
        }));
    });

    // Parse the part information
    const parsedParts = parts.map(part => {
        const parsed = parsePartText(part.part);
        return {
            ...part,
            ...parsed
        };
    });

    console.log(`Found ${parsedParts.length} parts`);
    return parsedParts;
}

async function scrapeLaws() {
    console.log('Starting to scrape Massachusetts General Laws...');
    const browser = await puppeteer.launch({
        headless: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    
    try {
        const parts = await getParts(page);
        const laws = {
            parts: []
        };

        for (const part of parts) {
            console.log(`\nProcessing ${part.part_title}: ${part.part_range}`);
            await page.goto(part.url);
            await page.waitForSelector('#accordion');
            await delay(2000);

            const titleElements = await page.$$('#accordion .panel');
            const titlesAndChapters = [];

            for (const titleElement of titleElements) {
                try {
                    // Get the title information before clicking
                    const titleInfo = await page.evaluate((element) => {
                        const titleLink = element.querySelector('.panel-title a');
                        const panelHeading = element.querySelector('.panel-heading');
                        if (!titleLink || !panelHeading) return null;

                        // Extract the title number (Roman numeral) and name
                        const headingText = panelHeading.textContent.trim();
                        const titleMatch = headingText.match(/Title\s+([IVX]+)\s+(.*?)(?:\n|$)/);
                        const titleNumber = titleMatch ? titleMatch[1] : titleLink.textContent.trim();
                        const titleName = titleMatch ? titleMatch[2].trim() : headingText;

                        return {
                            title: titleNumber,
                            title_name: titleName,
                            onclick: titleLink.getAttribute('onclick')
                        };
                    }, titleElement);

                    if (!titleInfo) continue;

                    // Extract the parameters from the onclick handler
                    const match = titleInfo.onclick.match(/accordionAjaxLoad\('(\d+)',\s*'(\d+)',\s*'([^']+)'\)/);
                    if (!match) continue;

                    const [_, partId, titleId, titleNum] = match;

                    // Call the accordionAjaxLoad function directly
                    await page.evaluate((partId, titleId, titleNum) => {
                        accordionAjaxLoad(partId, titleId, titleNum);
                    }, partId, titleId, titleNum);

                    // Wait for the chapters to be loaded
                    await page.waitForFunction(
                        (element) => {
                            const list = element.querySelector('.generalLawsList');
                            return list && list.children.length > 0;
                        },
                        { timeout: 10000 },
                        titleElement
                    );

                    const titleData = await page.evaluate((element) => {
                        const headingText = element.querySelector('.panel-heading').textContent.trim();
                        const titleMatch = headingText.match(/Title\s+([IVX]+)\s+(.*?)(?:\n|$)/);
                        const titleNumber = titleMatch ? titleMatch[1] : element.querySelector('.panel-title a').textContent.trim();
                        const titleName = titleMatch ? titleMatch[2].trim() : headingText;

                        const title = {
                            title: titleNumber,
                            title_name: titleName,
                            chapters: []
                        };

                        const chapterElements = element.querySelectorAll('.generalLawsList a');
                        chapterElements.forEach(chapterElement => {
                            title.chapters.push({
                                chapter: chapterElement.textContent.trim(),
                                chapter_title: chapterElement.getAttribute('title') || chapterElement.textContent.trim(),
                                url: chapterElement.href
                            });
                        });

                        return title;
                    }, titleElement);

                    if (titleData) {
                        // Parse the title information
                        const parsedTitle = parseTitleText(titleData.title);
                        if (parsedTitle) {
                            titleData.title = parsedTitle.title;
                            titleData.title_name = parsedTitle.title_name;
                        }

                        // Parse each chapter
                        titleData.chapters = titleData.chapters.map(chapter => {
                            const parsedChapter = parseChapterText(chapter.chapter);
                            return {
                                ...chapter,
                                ...parsedChapter
                            };
                        });

                        titlesAndChapters.push(titleData);
                        console.log(`Found ${titleData.chapters.length} chapters in Title ${titleData.title}`);
                    }
                } catch (error) {
                    console.log(`Error processing title: ${error.message}`);
                    continue;
                }
            }

            const partData = {
                ...part,
                titles: titlesAndChapters
            };

            laws.parts.push(partData);
            
            // Save progress after each part
            fs.writeFileSync(OUTPUT_FILE, JSON.stringify(laws, null, 2));
            console.log(`Saved progress for ${part.part_title}`);
        }

        console.log('\nScraping completed!');
        console.log(`Total parts processed: ${laws.parts.length}`);
        console.log(`Results saved to ${OUTPUT_FILE}`);
    } catch (error) {
        console.error('Error during scraping:', error);
    } finally {
        await browser.close();
    }
}

scrapeLaws(); 