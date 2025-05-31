document.addEventListener("DOMContentLoaded", function() {
    console.log("Page loaded");

    // Check if the user has visited before
    const hasVisited = localStorage.getItem("hasVisited");

    // Select the About, Experience, and Projects sections, with checks for existence
    const aboutSection = document.getElementById("about");
    const experienceItems = document.querySelectorAll(".experience-item.hidden");
    const projectsSection = document.getElementById("projects");

    if (!hasVisited) {
        console.log("First visit: running fade-in animations");

        // Check if `aboutSection` exists before adding the fade-in
        if (aboutSection) {
            aboutSection.classList.add("fade-in");
            console.log("About section fading in");
        }

        // Delay for Experience items fade-in, if any
        if (experienceItems.length > 0) {
            setTimeout(() => {
                experienceItems.forEach((item, index) => {
                    setTimeout(() => {
                        item.classList.remove("hidden");
                        item.classList.add("fade-in");
                    }, index * 300);
                });

                // Fade in Projects section after Experience items
                if (projectsSection) {
                    setTimeout(() => {
                        projectsSection.classList.remove("hidden");
                        projectsSection.classList.add("fade-in");
                    }, experienceItems.length * 300 + 600);
                }
            }, 1500);
        } else if (projectsSection) {
            // If no experience items but projects section exists, fade it in
            setTimeout(() => {
                projectsSection.classList.remove("hidden");
                projectsSection.classList.add("fade-in");
            }, 1500);
        }

        // Set the "hasVisited" flag in localStorage
        localStorage.setItem("hasVisited", "true");

    } else {
        // Returning visitor: skip animations
        console.log("Returning visit: skipping fade-in animations");

        // Ensure elements are made visible if they exist
        if (aboutSection) aboutSection.classList.remove("hidden");
        if (experienceItems.length > 0) experienceItems.forEach(item => item.classList.remove("hidden"));
        if (projectsSection) projectsSection.classList.remove("hidden");
    }

    // Markdown Conversion for Blog Post
    const converter = new showdown.Converter();
    const readMoreButton = document.getElementById("read-more-1");

    if (readMoreButton) {
        readMoreButton.addEventListener("click", function(event) {
            event.preventDefault();

            fetch('markdown/blog-post-1.md')
                .then(response => response.text())
                .then(markdown => {
                    const htmlContent = converter.makeHtml(markdown);
                    const contentDiv = document.getElementById("markdown-content-1");
                    if (contentDiv) {
                        contentDiv.innerHTML = htmlContent;
                        contentDiv.style.display = "block";
                    }
                })
                .catch(error => console.error('Error loading Markdown file:', error));
        });
    } else {
        console.warn("Warning: Read more button not found.");
    }

    // Search Functionality
    const searchInput = document.getElementById("searchInput");
    
    if (searchInput) {
        searchInput.addEventListener("input", function() {
            const searchTerm = searchInput.value.toLowerCase();
            
            // First look for blog-item class
            const blogItems = document.querySelectorAll(".blog-item");
            if (blogItems.length > 0) {
                blogItems.forEach(item => {
                    const title = item.querySelector(".card-title");
                    const content = item.querySelector(".card-text");
                    
                    if (title && content) {
                        const titleText = title.textContent.toLowerCase();
                        const contentText = content.textContent.toLowerCase();
                        
                        if (titleText.includes(searchTerm) || contentText.includes(searchTerm)) {
                            item.style.display = "block";
                        } else {
                            item.style.display = "none";
                        }
                    }
                });
            }
            
            // Then look for project-item class
            const projectItems = document.querySelectorAll(".project-item");
            if (projectItems.length > 0) {
                projectItems.forEach(item => {
                    const title = item.querySelector(".card-title");
                    const content = item.querySelector(".card-text");
                    
                    if (title && content) {
                        const titleText = title.textContent.toLowerCase();
                        const contentText = content.textContent.toLowerCase();
                        
                        if (titleText.includes(searchTerm) || contentText.includes(searchTerm)) {
                            item.style.display = "block";
                        } else {
                            item.style.display = "none";
                        }
                    }
                });
            }
        });
    }
});