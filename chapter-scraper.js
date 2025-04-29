const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const CHAPTER_URL = 'https://malegislature.gov/Laws/GeneralLaws/PartII/TitleI/Chapter186';
const OUTPUT_FILE = 'massachusetts_general_laws.json';

// Function to delay execution
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Function to get section links from the chapter page
async function getSectionLinks(chapterUrl) {
    try {
        console.log(`Navigating to chapter page: ${chapterUrl}`);
        await page.goto(chapterUrl, { waitUntil: 'networkidle0' });
        
        // Wait for the generalLawsList to be present
        await page.waitForSelector('ul.generalLawsList', { timeout: 10000 });
        
        // Extract section links and their details
        const sections = await page.evaluate(() => {
            const sectionElements = document.querySelectorAll('ul.generalLawsList li a');
            return Array.from(sectionElements).map(element => {
                const number = element.querySelector('.section').textContent.trim();
                const title = element.querySelector('.sectionTitle').textContent.trim();
                return {
                    number: number,
                    title: title,
                    url: element.href
                };
            });
        });
        
        console.log(`Found ${sections.length} sections`);
        return sections;
    } catch (error) {
        console.error('Error getting section links:', error);
        throw error;
    }
}

// Function to extract section details
async function getSectionDetails(browser, sectionUrl, sectionNumber) {
    try {
        console.log(`Processing section ${sectionNumber} at ${sectionUrl}`);
        const page = await browser.newPage();
        await page.goto(sectionUrl, { waitUntil: 'networkidle0' });

        // Wait for the main content container
        await page.waitForSelector('.col-xs-12.col-md-8');

        // Extract section title and content
        const sectionData = await page.evaluate(() => {
            // Get the section title from the h2 element
            const titleElement = document.querySelector('.genLawHeading');
            let title = '';
            if (titleElement) {
                const smallElement = titleElement.querySelector('small');
                title = smallElement ? smallElement.textContent.trim() : titleElement.textContent.trim();
            }

            // Get the section content from the main content area
            const contentContainer = document.querySelector('.col-xs-12.col-md-8 .col-xs-12');
            let content = '';
            
            if (contentContainer) {
                // Get all text nodes within the container
                const walker = document.createTreeWalker(
                    contentContainer,
                    NodeFilter.SHOW_TEXT,
                    null,
                    false
                );

                let node;
                while (node = walker.nextNode()) {
                    // Skip text in navigation buttons
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

            content = content.trim();

            return {
                title,
                content
            };
        });

        await page.close();

        return {
            section_number: sectionNumber,
            title: sectionData.title,
            content: sectionData.content,
            url: sectionUrl
        };
    } catch (error) {
        console.error(`Error processing section ${sectionNumber}:`, error);
        throw error;
    }
}

// Main scraping function
async function scrapeChapter() {
    const browser = await puppeteer.launch({ headless: "new" });
    page = await browser.newPage();
    
    try {
        console.log('Starting to scrape Chapter 186...');
        
        // Get all section links
        const sections = await getSectionLinks('https://malegislature.gov/Laws/GeneralLaws/PartII/TitleI/Chapter186');
        console.log(`Found ${sections.length} sections to process`);
        
        const results = {
            chapter: "Chapter 186",
            chapter_title: "Estates for Years and at Will",
            sections: [],
            metadata: {
                part: "Part II",
                title: "Title I",
                last_updated: new Date().toISOString().split('T')[0]
            }
        };
        
        for (const section of sections) {
            try {
                const sectionData = await getSectionDetails(browser, section.url, section.number);
                
                results.sections.push({
                    section: section.number,
                    section_title: section.title,
                    full_text: sectionData.content,
                    url: section.url
                });
                
            } catch (error) {
                console.error(`Failed to process section ${section.number}:`, error);
                
                // Add the section with empty content
                results.sections.push({
                    section: section.number,
                    section_title: section.title,
                    full_text: "",
                    url: section.url
                });
            }
        }
        
        // Save results to file
        fs.writeFileSync('massachusetts_general_laws.json', JSON.stringify(results, null, 2));
        console.log('\nScraping completed!');
        console.log(`Total sections processed: ${sections.length}`);
        console.log('Results saved to massachusetts_general_laws.json');
        
    } catch (error) {
        console.error('Error during scraping:', error);
    } finally {
        await browser.close();
    }
}

// Run the scraper
scrapeChapter(); 