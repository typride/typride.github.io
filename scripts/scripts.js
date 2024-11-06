document.addEventListener("DOMContentLoaded", function() {
    console.log("Page loaded");

    // Select the About, Experience, and Projects sections
    const aboutSection = document.getElementById("about");
    const experienceItems = document.querySelectorAll(".experience-item.hidden");
    const projectsSection = document.getElementById("projects");

    // Fade in the About section on page load
    aboutSection.classList.add("fade-in");
    console.log("About section fading in");

    // Start fading in Experience items after a set delay
    setTimeout(() => {
        experienceItems.forEach((item, index) => {
            setTimeout(() => {
                item.classList.remove("hidden");
                item.classList.add("fade-in");
                console.log(`Fading in experience item ${index + 1}`);
            }, index * 300); // Delay between each experience item
        });

        // Fade in Projects section after all experience items
        setTimeout(() => {
            projectsSection.classList.remove("hidden");
            projectsSection.classList.add("fade-in");
            console.log("Projects section fading in");
        }, experienceItems.length * 300 + 600); // Additional delay after the last experience item
    }, 1500); // Delay for About section fade-in
});