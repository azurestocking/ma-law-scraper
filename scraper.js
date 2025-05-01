const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://malegislature.gov/Laws/GeneralLaws';
const OUTPUT_FILE = 'massachusetts_general_laws.json';

const MAX_RETRIES = 3;
const RETRY_DELAY = 5000;

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

// Helper function to retry an operation
async function retryOperation(operation, maxRetries = MAX_RETRIES) {
    let lastError;
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            console.log(`Attempt ${i + 1} failed: ${error.message}`);
            if (i < maxRetries - 1) {
                console.log(`Retrying in ${RETRY_DELAY/1000} seconds...`);
                await delay(RETRY_DELAY);
            }
        }
    }
    throw lastError;
}

// Function to get section links from a chapter page
async function getSectionLinks(browser, chapterUrl) {
    const page = await browser.newPage();
    try {
        return await retryOperation(async () => {
            console.log(`Getting sections from: ${chapterUrl}`);
            await page.goto(chapterUrl, { 
                waitUntil: 'networkidle0',
                timeout: 30000
            });
            await delay(1000);
            
            await page.waitForSelector('ul.generalLawsList', { timeout: 10000 });
            
            const sections = await page.evaluate(() => {
                const sectionElements = document.querySelectorAll('ul.generalLawsList li a');
                return Array.from(sectionElements).map(element => {
                    const number = element.querySelector('.section')?.textContent.trim() || '';
                    const title = element.querySelector('.sectionTitle')?.textContent.trim() || '';
                    return {
                        number: number,
                        title: title,
                        url: element.href
                    };
                });
            });
            
            console.log(`Found ${sections.length} sections`);
            return sections;
        });
    } catch (error) {
        console.error('Error getting section links:', error);
        return [];
    } finally {
        await page.close();
    }
}

// Function to extract section details
async function getSectionDetails(browser, sectionUrl, sectionNumber) {
    const page = await browser.newPage();
    try {
        return await retryOperation(async () => {
            await page.goto(sectionUrl, { 
                waitUntil: 'networkidle0',
                timeout: 30000
            });
            await delay(1000);

            await page.waitForSelector('.col-xs-12.col-md-8', { timeout: 10000 });

            const sectionData = await page.evaluate(() => {
                const contentContainer = document.querySelector('.col-xs-12.col-md-8 .col-xs-12');
                let content = '';
                
                if (contentContainer) {
                    const walker = document.createTreeWalker(
                        contentContainer,
                        NodeFilter.SHOW_TEXT,
                        null,
                        false
                    );

                    let node;
                    while (node = walker.nextNode()) {
                        let parent = node.parentElement;
                        let isInNavigation = false;
                        let isInSmall = false;
                        while (parent) {
                            if (parent.classList && parent.classList.contains('btn-toolbar')) {
                                isInNavigation = true;
                                break;
                            }
                            if (parent.tagName === 'SMALL' && parent.closest('.genLawHeading')) {
                                isInSmall = true;
                                break;
                            }
                            parent = parent.parentElement;
                        }
                        
                        const text = node.textContent.trim();
                        if (text && !node.parentElement.classList.contains('genLawHeading') && !isInNavigation && !isInSmall) {
                            content += text + ' ';
                        }
                    }
                }

                return {
                    content: content.trim()
                };
            });

            return {
                section: sectionNumber,
                full_text: sectionData.content,
                url: sectionUrl
            };
        });
    } catch (error) {
        console.error(`Error processing section ${sectionNumber}:`, error);
        return {
            section: sectionNumber,
            full_text: "",
            url: sectionUrl
        };
    } finally {
        await page.close();
    }
}

async function getParts(browser) {
    const page = await browser.newPage();
    try {
        console.log('Getting parts...');
        await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
        await delay(2000); // Wait for any animations to complete
        
        await page.waitForSelector('.generalLawsList');

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
            const match = part.part.match(/Part\s+([IVX]+)\s+(.*?)(?:\s+Chapters\.\s+(\d+-\d+)|$)/);
            if (match) {
                return {
                    part: match[1],
                    part_title: match[2].trim(),
                    url: part.url
                };
            }
            return part;
        });

        console.log(`Found ${parsedParts.length} parts`);
        return parsedParts;
    } finally {
        await page.close();
    }
}

async function scrapeLaws() {
    console.log('Starting to scrape Massachusetts General Laws...');
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        protocolTimeout: 30000,
        timeout: 30000
    });
    
    try {
        let laws = { parts: [] };
        try {
            if (fs.existsSync(OUTPUT_FILE)) {
                const existingData = fs.readFileSync(OUTPUT_FILE, 'utf8');
                laws = JSON.parse(existingData);
                console.log(`Loaded existing data with ${laws.parts.length} parts`);
            }
        } catch (error) {
            console.log('Could not load existing data, starting fresh');
        }

        const parts = await getParts(browser);

        for (const part of parts) {
            console.log(`\nProcessing Part ${part.part}`);
            const page = await browser.newPage();
            
            try {
                await retryOperation(async () => {
                    // Set up page with better error handling
                    await page.setDefaultNavigationTimeout(30000);
                    await page.setDefaultTimeout(30000);
                    
                    // Enable network interception for better error handling
                    await page.setRequestInterception(true);
                    page.on('request', request => {
                        request.continue();
                    });
                    
                    // Add error handling for network issues
                    page.on('error', err => {
                        console.log('Page error:', err);
                    });
                    
                    page.on('pageerror', err => {
                        console.log('Page error:', err);
                    });
                    
                    await page.goto(part.url, { 
                        waitUntil: 'networkidle0',
                        timeout: 30000
                    });
                    await page.waitForSelector('#accordion', { timeout: 10000 });
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
                                    const chapterText = chapterElement.textContent.trim();
                                    const chapterMatch = chapterText.match(/Chapter\s+([\dA-Z]+)\s+(.*)/);
                                    
                                    if (chapterMatch) {
                                        title.chapters.push({
                                            chapter: chapterMatch[1],
                                            chapter_title: chapterMatch[2].trim(),
                                            url: chapterElement.href
                                        });
                                    } else {
                                        // Fallback if regex doesn't match
                                        const parts = chapterText.split(/\s+/);
                                        const chapterNum = parts[1] || '';
                                        const chapterTitle = parts.slice(2).join(' ').trim();
                                        title.chapters.push({
                                            chapter: chapterNum,
                                            chapter_title: chapterTitle || chapterText,
                                            url: chapterElement.href
                                        });
                                    }
                                });

                                return title;
                            }, titleElement);

                            if (titleData) {
                                // For each chapter, get its sections
                                for (const chapter of titleData.chapters) {
                                    console.log(`\nProcessing sections for Chapter ${chapter.chapter}`);
                                    const sections = await getSectionLinks(browser, chapter.url);
                                    
                                    // Check if chapter needs processing
                                    let needsProcessing = false;
                                    const existingPart = laws.parts.find(p => p.part === part.part);
                                    const existingTitle = existingPart?.titles?.find(t => t.title === titleData.title);
                                    const existingChapter = existingTitle?.chapters?.find(c => c.chapter === chapter.chapter);

                                    // If chapter doesn't exist in JSON, process all sections
                                    if (!existingChapter) {
                                        needsProcessing = true;
                                        console.log(`Chapter ${chapter.chapter} not found, will process all sections`);
                                    } else {
                                        // If chapter exist in JSON, check sections from website against JSON
                                        for (const section of sections) {
                                            const existingSection = existingChapter.sections?.find(s => s.section === section.number);
                                            
                                            // If section doesn't exist in JSON or is empty, process it
                                            if (!existingSection || 
                                                (existingSection.full_text.trim() === '' && 
                                                 !existingSection.section_title.toLowerCase().startsWith('Repealed'))) {
                                                needsProcessing = true;
                                                console.log(`Chapter ${chapter.chapter} Section ${section.number} needs to be processed`);
                                                break;
                                            }
                                        }
                                    }

                                    // Skip chapter if it doesn't need processing
                                    if (!needsProcessing) {
                                        console.log(`Skipping Chapter ${chapter.chapter}, all sections already processed`);
                                        continue;
                                    }

                                    console.log(`Processing Chapter ${chapter.chapter}`);
                                    const processedSections = [];
                                    const failedSections = [];
                                    
                                    // Function to process a single section
                                    async function processSection(section) {
                                        try {
                                            let shouldProcess = true;
                                            
                                            // Check if section exists in JSON
                                            if (existingChapter?.sections) {
                                                const existingSection = existingChapter.sections.find(s => s.section === section.number);
                                                
                                                if (existingSection) {
                                                    // Check if section has content or is repealed/inoperative
                                                    const hasContent = existingSection.full_text && existingSection.full_text.trim() !== '';
                                                    const isRepealedOrInoperative = existingSection.section_title && 
                                                                                  (existingSection.section_title.toLowerCase().startsWith('repealed') ||
                                                                                   existingSection.section_title.toLowerCase().startsWith('inoperative'));
                                                    
                                                    if (hasContent || isRepealedOrInoperative) {
                                                        console.log(`Section ${section.number} already processed - skipping`);
                                                        shouldProcess = false;
                                                    } else {
                                                        console.log(`Section ${section.number} exists but needs updating - processing`);
                                                    }
                                                } else {
                                                    console.log(`Section ${section.number} not found in JSON - processing`);
                                                }
                                            } else {
                                                console.log(`No sections found for chapter ${chapter.chapter} - processing section ${section.number}`);
                                            }

                                            if (shouldProcess) {
                                                // Process the section
                                                const sectionData = await getSectionDetails(browser, section.url, section.number);
                                                processedSections.push({
                                                    section: section.number,
                                                    section_title: section.title,
                                                    full_text: sectionData.full_text,
                                                    url: section.url
                                                });
                                                await delay(500);
                                            }
                                        } catch (error) {
                                            console.error(`Error processing section ${section.number}: ${error.message}`);
                                            failedSections.push({
                                                section: section,
                                                error: error.message
                                            });
                                        }
                                    }

                                    // Process all sections
                                    for (const section of sections) {
                                        await processSection(section);
                                    }

                                    // Retry failed sections for this chapter
                                    if (failedSections.length > 0) {
                                        console.log(`\nRetrying ${failedSections.length} failed sections for Chapter ${chapter.chapter}`);
                                        const retryFailedSections = [...failedSections];
                                        failedSections.length = 0; // Clear the array for the retry

                                        for (const failed of retryFailedSections) {
                                            try {
                                                console.log(`Retrying section ${failed.section.number}`);
                                                const sectionData = await getSectionDetails(browser, failed.section.url, failed.section.number);
                                                processedSections.push({
                                                    section: failed.section.number,
                                                    section_title: failed.section.title,
                                                    full_text: sectionData.full_text,
                                                    url: failed.section.url
                                                });
                                                await delay(500);
                                            } catch (error) {
                                                console.error(`Final retry failed for section ${failed.section.number}: ${error.message}`);
                                                failedSections.push(failed);
                                            }
                                        }
                                    }

                                    // After processing all sections, add any existing sections that were skipped
                                    if (existingChapter?.sections) {
                                        for (const existingSection of existingChapter.sections) {
                                            const wasProcessed = processedSections.some(s => s.section === existingSection.section);
                                            if (!wasProcessed) {
                                                processedSections.push(existingSection);
                                            }
                                        }
                                    }

                                    // Add sections to the chapter
                                    chapter.sections = processedSections;
                                    
                                    // Save progress after each chapter
                                    const partIndex = laws.parts.findIndex(p => p.part === part.part);
                                    if (partIndex === -1) {
                                        laws.parts.push({
                                            ...part,
                                            titles: [{
                                                ...titleData,
                                                chapters: [{
                                                    chapter: chapter.chapter,
                                                    chapter_title: chapter.chapter_title,
                                                    url: chapter.url,
                                                    sections: processedSections
                                                }]
                                            }]
                                        });
                                    } else {
                                        const titleIndex = laws.parts[partIndex].titles.findIndex(t => t.title === titleData.title);
                                        if (titleIndex === -1) {
                                            laws.parts[partIndex].titles.push({
                                                ...titleData,
                                                chapters: [{
                                                    chapter: chapter.chapter,
                                                    chapter_title: chapter.chapter_title,
                                                    url: chapter.url,
                                                    sections: processedSections
                                                }]
                                            });
                                        } else {
                                            const chapterIndex = laws.parts[partIndex].titles[titleIndex].chapters.findIndex(c => c.chapter === chapter.chapter);
                                            if (chapterIndex === -1) {
                                                laws.parts[partIndex].titles[titleIndex].chapters.push({
                                                    chapter: chapter.chapter,
                                                    chapter_title: chapter.chapter_title,
                                                    url: chapter.url,
                                                    sections: processedSections
                                                });
                                            } else {
                                                laws.parts[partIndex].titles[titleIndex].chapters[chapterIndex] = {
                                                    chapter: chapter.chapter,
                                                    chapter_title: chapter.chapter_title,
                                                    url: chapter.url,
                                                    sections: processedSections
                                                };
                                            }
                                        }
                                    }
                                    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(laws, null, 2));
                                    console.log(`Saved progress for Chapter ${chapter.chapter}`);
                                }

                                titlesAndChapters.push(titleData);
                                console.log(`Found ${titleData.chapters.length} chapters in Title ${titleData.title}`);
                            }
                        } catch (error) {
                            console.log(`Error processing title: ${error.message}`);
                            continue;
                        }
                    }
                });
            } finally {
                await page.close();
            }
        }

        // Final retry pass for any remaining failed sections
        console.log('\nStarting final retry pass for failed sections...');
        for (const part of laws.parts) {
            for (const title of part.titles) {
                for (const chapter of title.chapters) {
                    if (chapter.failedSections && chapter.failedSections.length > 0) {
                        console.log(`\nRetrying failed sections in Chapter ${chapter.chapter}`);
                        const retryFailedSections = [...chapter.failedSections];
                        chapter.failedSections = []; // Clear the array for the retry

                        for (const failed of retryFailedSections) {
                            try {
                                console.log(`Retrying section ${failed.section.number}`);
                                const sectionData = await getSectionDetails(browser, failed.section.url, failed.section.number);
                                chapter.failedSections.push({
                                    section: failed.section.number,
                                    section_title: failed.section.title,
                                    full_text: sectionData.full_text,
                                    url: failed.section.url
                                });
                                await delay(500);
                            } catch (error) {
                                console.error(`Final retry failed for section ${failed.section.number}: ${error.message}`);
                                chapter.failedSections.push(failed);
                            }
                        }
                    }
                }
            }
        }
    } finally {
        await browser.close();
    }
}

scrapeLaws();